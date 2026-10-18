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

def get_dealership_configuration(dealer_id: str):
    try:
        res = db.table("dealer_profiles").select("*").eq("id", dealer_id).execute()
        if res.data and len(res.data) > 0:
            return res.data[0]
    except Exception as e:
        print(f"[!] Warning reading dealer_profiles: {e}")
    return {}

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
    # Progressive smooth scrolling to wake up lazy-loaded vehicle image handlers
    scroll_height = await page.evaluate("document.body.scrollHeight")
    step = max(300, int(scroll_height / 8))
    for y in range(0, scroll_height, step):
        await page.evaluate(f"window.scrollTo(0, {y})")
        await asyncio.sleep(0.2)
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    await asyncio.sleep(1.0)

    vehicles = await page.evaluate("""(defaultCond) => {
        const results = [];
        const cards = document.querySelectorAll('.vehicle-card, .inventory-item, .vehicle-overview, .vehicle-item, [data-vin], .listing-card, .inventory-list-item, div[class*="inventory-card"], div[class*="vehicle-card"]');

        cards.forEach(card => {
            const cardText = card.innerText || "";
            const vinMatch = cardText.match(/\\b([A-HJ-NPR-Z0-9]{17})\\b/);
            if (!vinMatch) return;
            const vin = vinMatch[1];

            // 1. DETAIL LINK
            let detailUrl = null;
            const allLinks = Array.from(card.querySelectorAll('a[href]'));
            for (const a of allLinks) {
                const href = a.getAttribute('href') || '';
                if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
                if (/trade|kbb|value|finance|credit|contact|schedule|service|parts|direction|map|calc|review/i.test(href)) continue;

                if (href.includes(vin) || /\\/(used|new|certified|vehicle-details|inventory|vehicles)\\//i.test(href) || href.endsWith('.html') || href.endsWith('.htm')) {
                    try {
                        detailUrl = new URL(href, window.location.origin).href;
                        break;
                    } catch(e) {}
                }
            }
            if (!detailUrl) {
                const headingLink = card.querySelector('h2 a, h3 a, h4 a, .vehicle-title a, .title a');
                if (headingLink && headingLink.getAttribute('href')) {
                    try {
                        detailUrl = new URL(headingLink.getAttribute('href'), window.location.origin).href;
                    } catch(e) {}
                }
            }

            // 2. REAL VEHICLE PHOTO (Extract high-res lazy-loaded vehicle photos)
            let photoUrl = null;
            const mediaCandidates = Array.from(card.querySelectorAll('img, [data-src], [data-original], [data-lazy-src], [style*="background-image"]'));
            for (const el of mediaCandidates) {
                let candidate = null;
                if (el.tagName === 'IMG') {
                    candidate = el.getAttribute('data-original') || 
                                el.getAttribute('data-src') || 
                                el.getAttribute('data-lazy-src') || 
                                el.currentSrc || 
                                el.src;
                } else {
                    candidate = el.getAttribute('data-src') || el.getAttribute('data-original');
                    if (!candidate) {
                        const style = el.getAttribute('style') || '';
                        const match = style.match(/url\\(['"]?(http[^'"]+)['"]?\\)/i);
                        if (match) candidate = match[1];
                    }
                }

                if (candidate) {
                    if (candidate.startsWith('//')) candidate = window.location.protocol + candidate;
                    const lower = candidate.toLowerCase();
                    const isGarbage = lower.includes('/static/') || lower.includes('placeholder') || 
                                      lower.includes('logo') || lower.includes('banner') || 
                                      lower.includes('1x1') || lower.includes('pixel') || 
                                      lower.includes('icon') || lower.endsWith('.svg') ||
                                      lower.includes('coming-soon');

                    if (candidate.startsWith('http') && !isGarbage) {
                        photoUrl = candidate;
                        break;
                    }
                }
            }

            // 3. VEHICLE PRICE (Prioritize Internet Price / Final Price / Retail Price)
            let price = null;

            // Direct selector checks
            const pSelectors = [
                '[class*="internetPrice"]', '[class*="internet-price"]',
                '[class*="finalPrice"]', '[class*="final-price"]',
                '[class*="salePrice"]', '[class*="sale-price"]',
                '[class*="retailPrice"]', '[class*="retail-price"]',
                '.price-value', '.value'
            ];
            for (const sel of pSelectors) {
                const el = card.querySelector(sel);
                if (el && el.innerText) {
                    const num = parseInt(el.innerText.replace(/[^0-9]/g, ''));
                    if (num >= 4500 && num <= 250000) {
                        price = num;
                        break;
                    }
                }
            }

            // Text search targeting the exact price row
            if (!price) {
                const lines = cardText.split('\\n');
                for (const line of lines) {
                    // Skip discounts, down payments, and savings lines
                    if (/savings|discount|down payment|due at signing|per mo|\\/mo|rebate|doc fee/i.test(line)) continue;
                    
                    if (/internet price|final price|moses price|retail price|selling price|price:/i.test(line)) {
                        const m = line.match(/\\$\\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/);
                        if (m) {
                            const val = parseInt(m[1].replace(/,/g, ''));
                            if (val >= 4500 && val <= 250000) {
                                price = val;
                                break;
                            }
                        }
                    }
                }
            }

            // Last resort: highest dollar amount on the card that isn't MSRP
            if (!price) {
                const matches = Array.from(cardText.matchAll(/\\$\\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/g));
                const candidates = [];
                for (const match of matches) {
                    const val = parseInt(match[1].replace(/,/g, ''));
                    if (val >= 4500 && val <= 250000) {
                        candidates.push(val);
                    }
                }
                if (candidates.length > 0) {
                    price = candidates[0];
                }
            }

            // 4. ROOFTOP LOCATION
            let exactLocation = "";
            const locEl = card.querySelector('[class*="location"], [class*="dealership"], i[class*="marker"] ~ span');
            if (locEl && locEl.innerText.trim().length > 3) exactLocation = locEl.innerText.trim();
            if (!exactLocation) {
                const lines = cardText.split('\\n').map(l => l.trim()).filter(Boolean);
                for (const line of lines) {
                    if (/^(Moses|Hendrick|Sonic|CarMax|AutoNation|Ken Garff|Penske)/i.test(line) && !/Price|Stock|VIN|Save|Doc|Value|Trade/i.test(line)) {
                        exactLocation = line;
                        break;
                    }
                }
            }
            if (!exactLocation) exactLocation = "Dealership Lot";

            // 5. YEAR, MAKE, MODEL, TRIM
            const yearMatch = cardText.match(/\\b(20[0-2][0-9]|199[0-9])\\b/);
            const year = yearMatch ? parseInt(yearMatch[1]) : 2026;

            const commonMakes = ['Toyota', 'Honda', 'Ford', 'Chevrolet', 'Chevy', 'GMC', 'Jeep', 'Subaru', 'Nissan', 'Hyundai', 'Kia', 'BMW', 'Mercedes-Benz', 'Audi', 'Lexus', 'Ram', 'Dodge', 'Chrysler', 'Mazda', 'Volkswagen', 'VW', 'Cadillac', 'Buick', 'Acura', 'Lincoln', 'Volvo', 'Infiniti', 'Porsche', 'Mitsubishi'];
            let detectedMake = "Other";
            let detectedModel = "Vehicle";
            let detectedTrim = "";

            for (const m of commonMakes) {
                const regex = new RegExp('\\\\b' + m + '\\\\b\\\\s+([A-Za-z0-9\\\\-\\s]{2,40})', 'i');
                const mMatch = cardText.match(regex);
                if (mMatch) {
                    detectedMake = m;
                    const words = mMatch[1].split('\\n')[0].trim().split(' ').filter(Boolean);
                    detectedModel = words[0] || "Vehicle";
                    if (words.length > 1) detectedTrim = words.slice(1).join(' ').replace(/SE|LE|XLE|Sport|AWD|4WD|FWD/gi, '').trim();
                    break;
                }
            }

            // 6. MILEAGE
            const mileMatch = cardText.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})\\s*(?:miles|mi\\b)/i);
            const mileage = mileMatch ? parseInt(mileMatch[1].replace(/,/g, '')) : (defaultCond === "New" ? 5 : null);

            // 7. COLOR
            let color = "Standard";
            const colorRegex = /\\b(Black|White|Silver|Gray|Grey|Red|Blue|Navy|Brown|Green|Gold|Beige|Tan|Burgundy|Orange|Yellow|Charcoal)\\b/i;
            const extMatch = cardText.match(colorRegex);
            if (extMatch) {
                color = extMatch[1].charAt(0).toUpperCase() + extMatch[1].slice(1).toLowerCase();
                if (color === "Grey") color = "Gray";
            }

            // 8. BODY TYPE
            let bodyType = "Other";
            if (/SUV|Crossover|Sport Utility/i.test(cardText)) bodyType = "SUV";
            else if (/Truck|Crew Cab|Pickup/i.test(cardText)) bodyType = "Truck";
            else if (/Sedan/i.test(cardText)) bodyType = "Sedan";
            else if (/Van|Minivan|Odyssey|Sienna|Pacifica|Carnival/i.test(cardText)) bodyType = "Van";

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
                dealership_id: "moses",
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
    config = get_dealership_configuration(DEALERSHIP_ID)
    page_modifier = config.get("page_modifier") or "?pt={page}"

    feeds_to_crawl = []
    if config.get("used_url") and config.get("used_url").strip():
        feeds_to_crawl.append({"url": config["used_url"].strip(), "condition": "Used"})
    if config.get("certified_url") and config.get("certified_url").strip():
        feeds_to_crawl.append({"url": config["certified_url"].strip(), "condition": "Certified Pre-Owned"})
    if config.get("new_url") and config.get("new_url").strip():
        feeds_to_crawl.append({"url": config["new_url"].strip(), "condition": "New"})

    if not feeds_to_crawl:
        print(f"[-] No target URLs found in settings for '{DEALERSHIP_ID}'.")
        return

    print(f"[*] Starting crawl for {len(feeds_to_crawl)} feed(s): {[f['url'] for f in feeds_to_crawl]}")

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

        for feed in feeds_to_crawl:
            base_url = feed["url"]
            condition = feed["condition"]
            print(f"\n[*] Crawling: {condition} -> {base_url}")
            seen_vins = set()

            for pt in range(1, MAX_PAGES_PER_FEED + 1):
                url = build_page_url(base_url, page_modifier, pt)
                try:
                    response = await page.goto(url, wait_until="commit", timeout=30000)
                    if response and response.status == 404:
                        print(f"[!] 404 Page Not Found: {url}")
                        break
                except Exception as e:
                    print(f"[!] Navigation error: {e}")

                await asyncio.sleep(2)
                cars = await extract_cards_from_page(page, default_condition=condition)
                if not cars:
                    print(f"[-] No vehicle cards found on page {pt}. Finished {condition}.")
                    break

                vins = {c["vin"] for c in cars if c.get("vin")}
                if vins.issubset(seen_vins):
                    print(f"[-] Duplicate VIN batch on page {pt}. Reached the final page.")
                    break
                seen_vins.update(vins)

                saved = push_batch_to_supabase(cars)
                total_synced += saved
                valid_photos = sum(1 for c in cars if c.get("image_url"))
                valid_prices = sum(1 for c in cars if c.get("price"))
                print(f"[+] Page {pt}: Synced {saved} units | Real Prices: {valid_prices}/{len(cars)} | Real Photos: {valid_photos}/{len(cars)}")
                await asyncio.sleep(1)

        await browser.close()
    print(f"\n[✓] Crawl finished. Total live units synced: {total_synced}")

if __name__ == "__main__":
    asyncio.run(run_scraper())
