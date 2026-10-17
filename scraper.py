import asyncio
import os
import re
import sys
from typing import List
from playwright.async_api import async_playwright
from supabase import create_client

SUPABASE_URL = os.environ.get(
    "SUPABASE_URL", "https://tdsipiltwajwhzgjsupx.supabase.co"
)
SUPABASE_KEY = os.environ.get(
    "SUPABASE_KEY", "sb_publishable_hkEU-TniEPk-ShSxBZQ-kQ_zGrDUC8w"
)
DEALERSHIP_ID = os.environ.get("DEALERSHIP_ID", "moses")

db = create_client(SUPABASE_URL, SUPABASE_KEY)

MAX_PAGES_PER_FEED = 500
PAGE_MODIFIER = "?pt={page}"

FEEDS_TO_CRAWL = [
    {
        "url": "https://www.mosescars.com/search-all-used-inventory.html",
        "condition": "Used",
    },
    {
        "url": (
            "https://www.mosescars.com/search-all-certified-inventory.html"
        ),
        "condition": "Certified Pre-Owned",
    },
    {
        "url": "https://www.mosescars.com/search-all-new-inventory.html",
        "condition": "New",
    },
]


def build_page_url(base_url: str, modifier_pattern: str, page_num: int) -> str:
  if page_num == 1:
    return base_url
  mod = modifier_pattern.replace("{page}", str(page_num))
  if mod.startswith("?") and "?" in base_url:
    mod = "&" + mod[1:]
  if base_url.endswith("/") and mod.startswith("/"):
    return f"{base_url[:-1]}{mod}"
  return f"{base_url}{mod}"


async def extract_cards_from_page(
    page, default_condition: str = "Used"
) -> List[dict]:
  for fraction in [0.25, 0.5, 0.75, 1.0]:
    await page.evaluate(
        f"window.scrollTo(0, document.body.scrollHeight * {fraction})"
    )
    await asyncio.sleep(1.2)

  vehicles = await page.evaluate(
      """(defaultCond) => {
        const results = [];
        const cards = document.querySelectorAll('.vehicle-card, .inventory-item, .vehicle-overview, .vehicle-item, [data-vin], .listing-card, .inventory-list-item, div[class*="vehicle"]');

        cards.forEach(card => {
            const text = card.innerText || "";
            const vinMatch = text.match(/\\b([A-HJ-NPR-Z0-9]{17})\\b/);
            if (!vinMatch) return;
            const vin = vinMatch[1];

            let listingUrl = null;
            const linkTag = card.querySelector('a[href*="/vehicle-details/"], a[href*="/used/"], a[href*="/new/"], a[href*="/certified/"], a[href*=".htm"]');
            if (linkTag && linkTag.href) listingUrl = linkTag.href;

            let exactLocation = "";
            const locEl = card.querySelector('[class*="location"], [class*="dealership"], i[class*="marker"] ~ span, svg ~ span');
            if (locEl && locEl.innerText.trim().length > 3) exactLocation = locEl.innerText.trim();
            if (!exactLocation) {
                const lines = text.split('\\n').map(l => l.trim()).filter(Boolean);
                for (const line of lines) {
                    if (/^(Moses|Hendrick|Sonic|CarMax|AutoNation|Ken Garff|Penske)/i.test(line) && !/Price|Stock|VIN|Save|Doc/i.test(line)) {
                        exactLocation = line;
                        break;
                    }
                }
            }
            if (!exactLocation) exactLocation = "Moses Auto Group";

            let photoUrl = null;
            const images = Array.from(card.querySelectorAll('img, picture source, [style*="background-image"]'));
            for (const img of images) {
                let candidate = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src') || img.getAttribute('srcset') || img.getAttribute('src');
                if (candidate && candidate.includes(',')) candidate = candidate.split(',')[0].trim().split(' ')[0];
                if (!candidate && img.getAttribute('style')) {
                    const bgMatch = img.getAttribute('style').match(/url\\(['"]?(http[^'"]+)['"]?\\)/i);
                    if (bgMatch) candidate = bgMatch[1];
                }
                if (candidate && candidate.startsWith('//')) candidate = 'https:' + candidate;
                if (candidate && candidate.startsWith('http')) {
                    const lower = candidate.toLowerCase();
                    if (!lower.includes('logo') && !lower.includes('banner') && !lower.includes('badge') && !lower.includes('1x1')) {
                        photoUrl = candidate;
                        break;
                    }
                }
            }

            const yearMatch = text.match(/\\b(20[0-2][0-9]|199[0-9])\\b/);
            const year = yearMatch ? parseInt(yearMatch[1]) : 2026;

            const commonMakes = ['Toyota', 'Honda', 'Ford', 'Chevrolet', 'Chevy', 'GMC', 'Jeep', 'Subaru', 'Nissan', 'Hyundai', 'Kia', 'BMW', 'Mercedes-Benz', 'Audi', 'Lexus', 'Ram', 'Dodge', 'Chrysler', 'Mazda', 'Volkswagen', 'VW', 'Cadillac', 'Buick', 'Acura', 'Lincoln', 'Volvo', 'Infiniti', 'Porsche'];
            let detectedMake = "Other";
            let detectedModel = "Vehicle";
            let detectedTrim = "";

            for (const m of commonMakes) {
                const regex = new RegExp('\\\\b' + m + '\\\\b\\\\s+([A-Za-z0-9\\\\-\\s]{2,40})', 'i');
                const mMatch = text.match(regex);
                if (mMatch) {
                    detectedMake = m;
                    const words = mMatch[1].split('\\n')[0].trim().split(' ').filter(Boolean);
                    detectedModel = words[0] || "Vehicle";
                    if (words.length > 1) detectedTrim = words.slice(1).join(' ').replace(/SE|LE|XLE|Sport|AWD|4WD|FWD/gi, '').trim();
                    break;
                }
            }

            const priceMatches = Array.from(text.matchAll(/\\$\\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/g));
            let price = null;
            if (priceMatches.length > 0) {
                const parsedPrices = priceMatches.map(m => parseInt(m[1].replace(/,/g, ''))).filter(p => p > 1000 && p < 250000);
                price = parsedPrices.length ? parsedPrices[parsedPrices.length - 1] : null;
            }

            const mileMatch = text.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})\\s*(?:miles|mi\\b)/i);
            const mileage = mileMatch ? parseInt(mileMatch[1].replace(/,/g, '')) : (defaultCond === "New" ? 5 : null);

            let color = "Standard";
            const colorRegex = /\\b(Black|White|Silver|Gray|Grey|Red|Blue|Navy|Brown|Green|Gold|Beige|Tan|Burgundy|Orange|Yellow|Charcoal)\\b/i;
            const extMatch = text.match(colorRegex);
            if (extMatch) {
                color = extMatch[1].charAt(0).toUpperCase() + extMatch[1].slice(1).toLowerCase();
                if (color === "Grey") color = "Gray";
            }

            let bodyType = "Other";
            if (/SUV|Crossover|Sport Utility/i.test(text)) bodyType = "SUV";
            else if (/Truck|Crew Cab|Pickup/i.test(text)) bodyType = "Truck";
            else if (/Sedan/i.test(text)) bodyType = "Sedan";
            else if (/Van|Minivan/i.test(text)) bodyType = "Van";

            results.push({
                vin: vin,
                year: year,
                make: detectedMake,
                model: detectedModel,
                trim: detectedTrim,
                price: price,
                mileage: mileage,
                location_name: exactLocation,
                image_url: photoUrl,
                listing_url: listingUrl,
                color: color,
                body_type: bodyType,
                transmission: "Automatic",
                status: "Available",
                condition: defaultCond,
                is_active: true
            });
        });
        return results;
    }""",
      default_condition,
  )

  for v in vehicles:
    v["dealership_id"] = DEALERSHIP_ID
  return vehicles


def push_batch_to_supabase(records: List[dict]) -> int:
  if not records:
    return 0
  unique_by_vin = {r["vin"]: r for r in records if r.get("vin")}
  res = (
      db.table("scraped_inventory")
      .upsert(list(unique_by_vin.values()), on_conflict="vin")
      .execute()
  )
  return len(res.data)


async def run_scraper():
  job = (
      db.table("scrape_jobs")
      .insert({
          "dealership_id": DEALERSHIP_ID,
          "status": "running",
          "triggered_by": "cloud_worker",
      })
      .execute()
  )
  job_id = job.data[0]["id"] if job.data else None

  total_synced = 0
  try:
    async with async_playwright() as p:
      browser = await p.chromium.launch(
          headless=True, args=["--no-sandbox", "--disable-setuid-sandbox"]
      )
      context = await browser.new_context(
          user_agent=(
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          )
      )
      page = await context.new_page()

      for feed in FEEDS_TO_CRAWL:
        base_url = feed["url"]
        condition = feed["condition"]
        seen_vins = set()

        for pt in range(1, MAX_PAGES_PER_FEED + 1):
          url = build_page_url(base_url, PAGE_MODIFIER, pt)
          try:
            await page.goto(url, wait_until="commit", timeout=25000)
          except Exception:
            pass
          await asyncio.sleep(2)

          cars = await extract_cards_from_page(page, default_condition=condition)
          if not cars:
            break

          vins = {c["vin"] for c in cars if c.get("vin")}
          if vins.issubset(seen_vins):
            break
          seen_vins.update(vins)

          saved = push_batch_to_supabase(cars)
          total_synced += saved
          await asyncio.sleep(1)

      await browser.close()

    if job_id:
      db.table("scrape_jobs").update({
          "status": "completed",
          "cars_synced": total_synced,
          "completed_at": "now()",
      }).eq("id", job_id).execute()
    print(f"Scraper finished cleanly. Total synced: {total_synced}")

  except Exception as e:
    if job_id:
      db.table("scrape_jobs").update(
          {"status": "failed", "completed_at": "now()"}
      ).eq("id", job_id).execute()
    raise e


if __name__ == "__main__":
  asyncio.run(run_scraper())
