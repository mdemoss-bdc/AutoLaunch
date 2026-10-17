import asyncio
import os
import re
import sys
from typing import List
from playwright.async_api import async_playwright
from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://tdsipiltwajwhzgjsupx.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "sb_publishable_hkEU-TniEPk-ShSxBZQ-kQ_zGrDUC8w")
DEALERSHIP_ID = os.environ.get("DEALERSHIP_ID", "moses")

db = create_client(SUPABASE_URL, SUPABASE_KEY)

MAX_PAGES_PER_FEED = 500
PAGE_MODIFIER = "?pt={page}"

FEEDS_TO_CRAWL = [
    {"url": "https://www.mosescars.com/search-all-used-inventory.html", "condition": "Used"},
    {"url": "https://www.mosescars.com/search-all-certified-inventory.html", "condition": "Certified Pre-Owned"},
    {"url": "https://www.mosescars.com/search-all-new-inventory.html", "condition": "New"}
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

async def extract_cards_from_page(page, default_condition: str = "Used") -> List[dict]:
    # Progressive scroll to trigger all dynamic lazy loaders across any dealer platform
    for fraction in [0.25, 0.5, 0.75, 1.0]:
        await page.evaluate(f"window.scrollTo(0, document.body.scrollHeight * {fraction})")
        await asyncio.sleep(0.8)

    vehicles = await page.evaluate("""(defaultCond) => {
        const results = [];
        const cards = document.querySelectorAll('.vehicle-card, .inventory-item, .vehicle-overview, .vehicle-item, [data-vin], .listing-card, .inventory-list-item, div[class*="vehicle"]');

        cards.forEach(card => {
            const text = card.innerText || "";
            const vinMatch = text.match(/\\b([A-HJ-NPR-Z0-9]{17})\\b/);
            if (!vinMatch) return;
            const vin = vinMatch[1];

            // 1. Universal Detail Link: Grab the first valid navigable link from the card
            let detailUrl = null;
            const allLinks = Array.from(card.querySelectorAll('a[href]'));
            for (const a of allLinks) {
                const href = a.getAttribute('href') || '';
                if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
                
                // Exclude generic action buttons (e.g., share, call, directions)
                if (/tel:|mailto:|map|direction|contact|schedule/i.test(href)) continue;

                try {
                    const resolved = new URL(href, window.location.origin).href;
                    detailUrl = resolved;
                    break;
                } catch(e) {}
            }

            // 2. Rooftop Location
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
            if (!exactLocation) exactLocation = "Dealership Lot";

            // 3. Universal Image Extraction
            let photoUrl = null;
            const imgs = Array.from(card.querySelectorAll('img, [style*="background-image"]'));
            for (const img of imgs) {
                let candidate = null;
                if (img.tagName === 'IMG') {
                    candidate = img.currentSrc || 
                                img.getAttribute('data-original') || 
                                img.getAttribute('data-src') || 
                                img.getAttribute('data-lazy-src') || 
                                img.src;
                } else {
                    const style = img.getAttribute('style') || '';
                    const match = style.match(/url\\(['"]?(http[^'"]+)['"]?\\)/i);
                    if (match) candidate = match[1];
                }

                if (candidate) {
                    if (candidate.startsWith('//')) candidate = window.location.protocol + candidate;
                    const lower = candidate.toLowerCase();
                    const isGarbage = lower.includes('/static/') || lower.includes('placeholder') || 
                                      lower.includes('logo') || lower.includes('banner') || 
                                      lower.includes('1x1') || lower.includes('pixel') || 
                                      lower.endsWith('.svg');

                    if (candidate.startsWith('http') && !isGarbage) {
                        photoUrl = candidate;
                        break;
                    }
                }
            }

            // 4. Year, Make, Model, Trim
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

            // 5. Price & Mileage
            const priceMatches = Array.from(text.matchAll(/\\$\\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/g));
            let price = null;
            if (priceMatches.length > 0) {
                const parsedPrices = priceMatches.map(m => parseInt(m[1].replace(/,/g, ''))).filter(p => p > 1000 && p < 250000);
                price = parsedPrices.length ? parsedPrices[parsedPrices.length - 1] : null;
            }

            const mileMatch = text.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})\\s*(?:miles|mi\\b)/i);
            const mileage = mileMatch ? parseInt(mileMatch[1].replace(/,/g, '')) : (defaultCond === "New" ? 5 : null);

            // 6. Color
            let color = "Standard";
            const colorRegex = /\\b(Black|White|Silver|Gray|Grey|Red|Blue|Navy|Brown|Green|Gold|Beige|Tan|Burgundy|Orange|Yellow|Charcoal)\\b/i;
            const extMatch = text.match(colorRegex);
            if (extMatch) {
                color = extMatch[1].charAt(0).toUpperCase() + extMatch[1].slice(1).toLowerCase();
                if (color === "Grey") color = "Gray";
            }

            // 7. Body Type
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
                detail_url: detailUrl,
                color: color,
                body_type: bodyType,
                transmission: "Automatic",
                status: "Available",
                condition: defaultCond,
                is_active: true
            });
        });
        return results;
    }""", default_condition)

    return vehicles

def push_batch_to_supabase(records: List[dict]) -> int:
    if not records:
        return 0
    unique_by_vin = {r["vin"]: r for r in records if r.get("vin")}
    try:
        res = db.table("scraped_inventory").upsert(list(unique_by_vin.values()), on_conflict="vin").execute()
        return len(res.data) if res.data else 0
    except Exception as e:
        print(f"[!] Batch upsert error: {e}")
        return 0

async def run_scraper():
    total_synced = 0
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
            viewport={"width": 1920, "height": 1080}
        )
        page = await context.new_page()

        for feed in FEEDS_TO_CRAWL:
            base_url = feed["url"]
            condition = feed["condition"]
            print(f"\n[*] Starting Feed: {condition} ({base_url})")
            seen_vins = set()

            for pt in range(1, MAX_PAGES_PER_FEED + 1):
                url = build_page_url(base_url, PAGE_MODIFIER, pt)
                try:
                    await page.goto(url, wait_until="commit", timeout=30000)
                except Exception as e:
                    print(f"[!] Navigation error: {e}")

                await asyncio.sleep(2)
                cars = await extract_cards_from_page(page, default_condition=condition)
                if not cars:
                    break

                vins = {c["vin"] for c in cars if c.get("vin")}
                if vins.issubset(seen_vins):
                    break
                seen_vins.update(vins)

                saved = push_batch_to_
