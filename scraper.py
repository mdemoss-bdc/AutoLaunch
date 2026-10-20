import asyncio
import os
import re
import sys
from typing import List
from playwright.async_api import async_playwright
from supabase import create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL") or "https://tdsipiltwajwhzgjsupx.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_KEY") or "sb_publishable_hkEU-TniEPk-ShSxBZQ-kQ_zGrDUC8w"
USER_ID = os.environ.get("USER_ID")

db = create_client(SUPABASE_URL, SUPABASE_KEY)

MAX_PAGES_PER_FEED = 500

def get_user_configuration(uid: str):
    if not uid:
        print("[!] No USER_ID passed to scraper.")
        return {}
    try:
        res = db.table("user_settings").select("*").eq("user_id", uid).execute()
        if res.data and len(res.data) > 0:
            return res.data[0]
    except Exception as e:
        print(f"[!] Warning reading user_settings: {e}")
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

async def extract_cards_from_page(page, default_condition: str = "Used", active_uid: str = "") -> List[dict]:
    scroll_height = await page.evaluate("document.body.scrollHeight")
    step = max(350, int(scroll_height / 10))
    for y in range(0, scroll_height, step):
        await page.evaluate(f"window.scrollTo(0, {y})")
        await asyncio.sleep(0.15)
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    await asyncio.sleep(1.0)

    vehicles = await page.evaluate("""([defaultCond, uid]) => {
        const results = [];
        const seenVins = new Set();

        const commonMakes = [
            'Toyota', 'Honda', 'Ford', 'Chevrolet', 'Chevy', 'GMC', 'Jeep', 
            'Subaru', 'Nissan', 'Hyundai', 'Kia', 'BMW', 'Mercedes-Benz', 
            'Audi', 'Lexus', 'Ram', 'Dodge', 'Chrysler', 'Mazda', 'Volkswagen', 
            'VW', 'Cadillac', 'Buick', 'Acura', 'Lincoln', 'Volvo', 'Infiniti', 
            'Porsche', 'Mitsubishi'
        ];

        function parseFromUrl(url) {
            if (!url) return null;
            // Matches formats like: /used-Huntington-2020-Lincoln-NAUTILUS-SUV-2LMPJ8K94LBL05090
            const m = url.match(/(?:used|new|cpo|certified)-[^-]+-(\\d{4})-([A-Za-z0-9]+)-([A-Za-z0-9]+)(?:-([A-Za-z0-9_-]+))?/i);
            if (m) {
                return {
                    year: parseInt(m[1]),
                    make: m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase(),
                    model: m[3].charAt(0).toUpperCase() + m[3].slice(1).toLowerCase(),
                    trim: (m[4] || '').replace(/SUV|Sedan|Truck|Coupe/gi, '').trim()
                };
            }
            return null;
        }

        // STRATEGY 1: JSON-LD / SCHEMA.ORG
        try {
            const jsonScripts = document.querySelectorAll('script[type="application/ld+json"]');
            jsonScripts.forEach(script => {
                try {
                    let data = JSON.parse(script.innerText);
                    if (!data) return;
                    let items = [];
                    if (Array.isArray(data)) items = data;
                    else if (data['@graph'] && Array.isArray(data['@graph'])) items = data['@graph'];
                    else items = [data];

                    items.forEach(item => {
                        const type = (item['@type'] || '').toLowerCase();
                        if (type.includes('car') || type.includes('vehicle') || type.includes('product') || item.vehicleIdentificationNumber || item.vin) {
                            const vin = item.vehicleIdentificationNumber || item.vin;
                            if (vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin) && !seenVins.has(vin.toUpperCase())) {
                                seenVins.add(vin.toUpperCase());

                                let price = null;
                                if (item.offers) {
                                    const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
                                    if (offer && offer.price) {
                                        const p = parseInt(String(offer.price).replace(/[^0-9]/g, ''));
                                        if (p >= 4000 && p <= 350000) price = p;
                                    }
                                }

                                let image = null;
                                if (item.image) {
                                    if (typeof item.image === 'string') image = item.image;
                                    else if (Array.isArray(item.image) && item.image[0]) {
                                        image = typeof item.image[0] === 'string' ? item.image[0] : (item.image[0].url || item.image[0].contentUrl);
                                    } else if (item.image.url) {
                                        image = item.image.url;
                                    }
                                }

                                let url = item.url || (item.offers && item.offers.url ? item.offers.url : null);
                                if (url && url.startsWith('/')) url = window.location.origin + url;

                                let year = item.modelDate ? parseInt(item.modelDate) : null;
                                if (!year && item.name) {
                                    const yM = item.name.match(/\\b(20[0-2][0-9]|199[0-9])\\b/);
                                    if (yM) year = parseInt(yM[1]);
                                }

                                let make = (typeof item.brand === 'object' ? (item.brand.name || '') : (item.brand || item.manufacturer || '')).trim();
                                let model = (item.model || '').trim();
                                let trim = '';

                                // Overwrite if URL contains exact vehicle specs
                                const urlParsed = parseFromUrl(url);
                                if (urlParsed) {
                                    year = urlParsed.year || year;
                                    make = urlParsed.make || make;
                                    model = urlParsed.model || model;
                                    trim = urlParsed.trim || '';
                                }

                                if (model.toUpperCase() === 'VIN' || !model) model = 'Vehicle';
                                if (!make || make.toUpperCase() === 'OTHER') make = 'Other';

                                const mileage = item.mileageFromOdometer ? parseInt(String(item.mileageFromOdometer.value || item.mileageFromOdometer).replace(/[^0-9]/g, '')) : null;

                                let stockNum = (item.sku || item.identifier || item.mpn || '').toString().trim();
                                if (!stockNum || stockNum.toLowerCase() === 'n/a') {
                                    stockNum = vin.toUpperCase().slice(-8);
                                }

                                results.push({
                                    vin: vin.toUpperCase(),
                                    stock_number: stockNum,
                                    user_id: uid,
                                    year: year || 2026,
                                    make: make,
                                    model: model,
                                    trim: trim,
                                    price: price,
                                    mileage: mileage,
                                    location_name: "Dealership Lot",
                                    image_url: image,
                                    detail_url: url,
                                    color: (item.color || 'Standard'),
                                    body_type: (item.bodyType || 'Other'),
                                    transmission: "Automatic",
                                    status: "Available",
                                    condition: defaultCond,
                                    is_active: true
                                });
                            }
                        }
                    });
                } catch(e) {}
            });
        } catch(e) {}

        if (results.length > 0) return results;

        // STRATEGY 2: UNIVERSAL DOM MATRIX
        const cardSelectors = [
            '.vehicle-card', '.inventory-item', '.vehicle-overview', '.vehicle-item',
            '.inventory-list-item', '.vehicleListCard', '.vehicleCard', '.v-card',
            '.inventory-vehicle', '.vehicle-list-item', '[data-vin]', '.listing-card',
            'div[class*="inventory-card"]', 'div[class*="vehicle-card"]'
        ];

        const cards = document.querySelectorAll(cardSelectors.join(', '));
        cards.forEach(card => {
            const cardText = card.innerText || "";
            let vin = card.getAttribute('data-vin') || 
                      card.getAttribute('data-vehicle-vin') || 
                      (card.querySelector('[data-vin]') ? card.querySelector('[data-vin]').getAttribute('data-vin') : null);

            if (!vin) {
                const vinMatch = cardText.match(/\\b([A-HJ-NPR-Z0-9]{17})\\b/i);
                if (vinMatch) vin = vinMatch[1];
            }
            if (!vin || vin.length !== 17 || seenVins.has(vin.toUpperCase())) return;
            seenVins.add(vin.toUpperCase());

            // 1. DETAIL URL
            let detailUrl = null;
            const allLinks = Array.from(card.querySelectorAll('a[href]'));
            for (const a of allLinks) {
                const href = a.getAttribute('href') || '';
                if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
                if (/trade|kbb|value|finance|credit|contact|schedule|service|parts|direction|map|calc|review/i.test(href)) continue;

                if (href.toUpperCase().includes(vin.toUpperCase()) || 
                    /\\/(used|new|certified|vehicle-details|inventory|vehicles|vdp)\\//i.test(href) || 
                    href.endsWith('.html') || href.endsWith('.htm')) {
                    try {
                        detailUrl = new URL(href, window.location.origin).href;
                        break;
                    } catch(e) {}
                }
            }
            if (!detailUrl) {
                const hLink = card.querySelector('h2 a, h3 a, h4 a, .vehicle-title a, .title a, a[class*="headline"]');
                if (hLink && hLink.getAttribute('href')) {
                    try {
                        detailUrl = new URL(hLink.getAttribute('href'), window.location.origin).href;
                    } catch(e) {}
                }
            }

            // 2. STOCK NUMBER EXTRACTION
            let stockNum = card.getAttribute('data-stocknumber') || 
                           card.getAttribute('data-stock') || 
                           card.getAttribute('data-stock-number');

            if (!stockNum) {
                const stockEl = card.querySelector('[class*="stock-number"], [class*="stockNumber"], [class*="stock_number"], .stock, .stock-num, [data-name="stockNumber"]');
                if (stockEl) {
                    const text = stockEl.innerText.replace(/Stock\\s*(?:#|Number|No|:)?\\s*/i, '').trim();
                    if (text && text.length >= 3 && !text.toUpperCase().includes('N/A')) {
                        stockNum = text;
                    }
                }
            }

            if (!stockNum) {
                const stockMatch = cardText.match(/Stock\\s*(?:#|Number|No|:)?\\s*([A-Za-z0-9_-]{3,15})/i);
                if (stockMatch && stockMatch[1] && !stockMatch[1].toUpperCase().includes('VIN')) {
                    stockNum = stockMatch[1].trim();
                }
            }

            if (!stockNum) {
                stockNum = vin.toUpperCase().slice(-8);
            }

            // 3. VEHICLE PHOTO
            let photoUrl = null;
            const imgs = Array.from(card.querySelectorAll('img, source[srcset], [data-src], [data-original], [data-lazy-src], [data-lazy], [data-image], .photo-thumb img, picture img'));
            for (const el of imgs) {
                let candidate = el.getAttribute('data-src') || 
                                el.getAttribute('data-original') || 
                                el.getAttribute('data-lazy-src') || 
                                el.getAttribute('data-lazy') || 
                                el.getAttribute('data-image') || 
                                (el.tagName === 'SOURCE' ? el.getAttribute('srcset') : null) ||
                                el.currentSrc || 
                                el.getAttribute('src');

                if (candidate) {
                    if (candidate.includes(',')) candidate = candidate.split(',')[0].trim().split(' ')[0];
                    if (candidate.startsWith('//')) candidate = window.location.protocol + candidate;
                    else if (candidate.startsWith('/')) candidate = window.location.origin + candidate;

                    const lower = candidate.toLowerCase();
                    const isGarbage = lower.includes('/static/') || lower.includes('placeholder') || 
                                      lower.includes('logo') || lower.includes('banner') || 
                                      lower.includes('1x1') || lower.includes('pixel') || 
                                      lower.includes('icon') || lower.endsWith('.svg') || 
                                      lower.includes('coming-soon') || lower.includes('stock-image') ||
                                      lower.includes('photo-coming');

                    if (candidate.startsWith('http') && !isGarbage) {
                        photoUrl = candidate;
                        break;
                    }
                }
            }

            // 4. PRICE EXTRACTION
            let price = null;
            const priceSelectors = [
                '[class*="mosesPrice"]', '[class*="moses-price"]',
                '[class*="finalPrice"]', '[class*="final-price"]',
                '[class*="internetPrice"]', '[class*="internet-price"]',
                '[class*="salePrice"]', '[class*="sale-price"]',
                '.final-price .price-value', '.internet-price .price-value', '.selling-price',
                '.normal-price .price', '.di-price', '.price-details .price',
                '[data-price]', '[itemprop="price"]', '.primary-price', '.price-value', '.value'
            ];

            for (const sel of priceSelectors) {
                const el = card.querySelector(sel);
                if (el) {
                    const dataP = el.getAttribute('data-price') || el.getAttribute('content');
                    if (dataP && parseInt(dataP) >= 4000) {
                        price = parseInt(dataP);
                        break;
                    }
                    if (el.innerText) {
                        const num = parseInt(el.innerText.replace(/[^0-9]/g, ''));
                        if (num >= 4000 && num <= 350000) {
                            price = num;
                            break;
                        }
                    }
                }
            }

            if (!price) {
                const lines = cardText.split('\\n').map(l => l.trim()).filter(Boolean);
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (/per mo|\\/mo|down|discount|savings|rebate|doc fee|estimate/i.test(line)) continue;

                    if (/price|final|sale|internet|selling|our price|market price/i.test(line)) {
                        const m = line.match(/\\$\\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/);
                        if (m) {
                            const val = parseInt(m[1].replace(/,/g, ''));
                            if (val >= 4000 && val <= 350000) {
                                price = val;
                                break;
                            }
                        }
                    }
                }
            }

            // 5. LOCATION
            let exactLocation = "";
            const locEl = card.querySelector('[class*="location"], [class*="dealership"], [class*="store-name"], i[class*="marker"] ~ span');
            if (locEl && locEl.innerText.trim().length > 3) exactLocation = locEl.innerText.trim();
            if (!exactLocation) {
                const lines = cardText.split('\\n').map(l => l.trim()).filter(Boolean);
                for (const line of lines) {
                    if (/^(Moses|Hendrick|Sonic|CarMax|AutoNation|Ken Garff|Penske|Bill|Bob|Joe|Jim)/i.test(line) && !/Price|Stock|VIN|Save|Doc|Value|Trade/i.test(line)) {
                        exactLocation = line;
                        break;
                    }
                }
            }
            if (!exactLocation) exactLocation = "Dealership Lot";

            // 6. YEAR, MAKE, MODEL, TRIM EXTRACTION
            const urlData = parseFromUrl(detailUrl);
            let year = urlData ? urlData.year : null;
            let detectedMake = urlData ? urlData.make : null;
            let detectedModel = urlData ? urlData.model : null;
            let detectedTrim = urlData ? urlData.trim : "";

            if (!year) {
                const yearMatch = cardText.match(/\\b(20[0-2][0-9]|199[0-9])\\b/);
                year = yearMatch ? parseInt(yearMatch[1]) : 2026;
            }

            // Title element search if URL parsing was not possible
            if (!detectedMake || detectedMake === 'Other') {
                const titleHeading = card.querySelector('h2, h3, h4, .vehicle-title, [class*="title"]');
                const titleStr = titleHeading ? titleHeading.innerText.trim() : cardText;

                for (const m of commonMakes) {
                    const regex = new RegExp('\\\\b' + m + '\\\\b\\\\s+([A-Za-z0-9\\\\-\\s]{2,40})', 'i');
                    const mMatch = titleStr.match(regex);
                    if (mMatch) {
                        detectedMake = m;
                        const words = mMatch[1].split('\\n')[0].trim().split(' ').filter(Boolean);
                        detectedModel = words[0] || "Vehicle";
                        if (words.length > 1) {
                            detectedTrim = words.slice(1).join(' ').replace(/SE|LE|XLE|Sport|AWD|4WD|FWD/gi, '').trim();
                        }
                        break;
                    }
                }
            }

            // Safety guards against generic defaults
            if (!detectedMake) detectedMake = "Other";
            if (!detectedModel || detectedModel.toUpperCase() === 'VIN') detectedModel = "Vehicle";

            // 7. MILEAGE
            const mileMatch = cardText.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})\\s*(?:miles|mi\\b)/i);
            const mileage = mileMatch ? parseInt(mileMatch[1].replace(/,/g, '')) : (defaultCond === "New" ? 5 : null);

            // 8. COLOR
            let color = "Standard";
            const colorRegex = /\\b(Black|White|Silver|Gray|Grey|Red|Blue|Navy|Brown|Green|Gold|Beige|Tan|Burgundy|Orange|Yellow|Charcoal)\\b/i;
            const extMatch = cardText.match(colorRegex);
            if (extMatch) {
                color = extMatch[1].charAt(0).toUpperCase() + extMatch[1].slice(1).toLowerCase();
                if (color === "Grey") color = "Gray";
            }

            // 9. BODY TYPE
            let bodyType = "Other";
            if (/SUV|Crossover|Sport Utility/i.test(cardText)) bodyType = "SUV";
            else if (/Truck|Crew Cab|Pickup/i.test(cardText)) bodyType = "Truck";
            else if (/Sedan/i.test(cardText)) bodyType = "Sedan";
            else if (/Coupe|Mustang/i.test(cardText)) bodyType = "Coupe";
            else if (/Van|Minivan|Odyssey|Sienna|Pacifica/i.test(cardText)) bodyType = "Van";

            results.push({
                vin: vin.toUpperCase(),
                stock_number: stockNum,
                user_id: uid,
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
    }""", [default_condition, active_uid])

    return vehicles

def push_batch_to_supabase(records: List[dict]) -> int:
    if not records:
        return 0
    unique_by_vin = {r["vin"]: r for r in records if r.get("vin")}
    try:
        res = db.table("scraped_inventory").upsert(
            list(unique_by_vin.values()), 
            on_conflict="vin, user_id"
        ).execute()
        return len(res.data) if res.data else 0
    except Exception as e:
        print(f"[!] Batch upsert error: {e}")
        return 0

async def run_scraper():
    # 1. Check if a single user ID was passed in via environment variable
    target_uid = os.environ.get("USER_ID")

    if target_uid and target_uid.strip():
        # Crawl only this specific user
        res = db.table("user_settings").select("*").eq("user_id", target_uid.strip()).execute()
        users_to_scrape = res.data or []
    else:
        # Cloud/Scheduled run: Crawl ALL registered users who configured dealership URLs
        res = db.table("user_settings").select("*").execute()
        users_to_scrape = res.data or []

    if not users_to_scrape:
        print("[-] No user accounts with configured dealership settings found.")
        return

    print(f"[*] Found {len(users_to_scrape)} account(s) registered in database.")

    total_synced_all = 0
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

        for user_cfg in users_to_scrape:
            active_uid = user_cfg.get("user_id")
            if not active_uid:
                continue

            store_name = user_cfg.get("dealership_name") or user_cfg.get("store_name") or "User Store"
            page_modifier = user_cfg.get("page_modifier") or "?pt={page}"

            feeds_to_crawl = []
            if user_cfg.get("used_url") and user_cfg.get("used_url").strip():
                feeds_to_crawl.append({"url": user_cfg["used_url"].strip(), "condition": "Used"})
            if user_cfg.get("certified_url") and user_cfg.get("certified_url").strip():
                feeds_to_crawl.append({"url": user_cfg["certified_url"].strip(), "condition": "Certified Pre-Owned"})
            if user_cfg.get("new_url") and user_cfg.get("new_url").strip():
                feeds_to_crawl.append({"url": user_cfg["new_url"].strip(), "condition": "New"})

            if not feeds_to_crawl:
                print(f"[-] Skipping User {active_uid[:8]} ({store_name}): No inventory URLs entered yet.")
                continue

            print(f"\n=======================================================")
            print(f"[*] Crawling for User: {active_uid} | Store: {store_name}")
            print(f"=======================================================")

            user_units_synced = 0
            for feed in feeds_to_crawl:
                base_url = feed["url"]
                condition = feed["condition"]
                print(f"[*] Crawling feed: {condition} -> {base_url}")
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
                    cars = await extract_cards_from_page(page, default_condition=condition, active_uid=active_uid)
                    if not cars:
                        print(f"[-] No cards found on page {pt}. Finished {condition}.")
                        break

                    vins = {c["vin"] for c in cars if c.get("vin")}
                    if vins.issubset(seen_vins):
                        print(f"[-] Duplicate batch on page {pt}. Finished {condition}.")
                        break
                    seen_vins.update(vins)

                    saved = push_batch_to_supabase(cars)
                    user_units_synced += saved
                    valid_photos = sum(1 for c in cars if c.get("image_url"))
                    valid_prices = sum(1 for c in cars if c.get("price"))
                    print(f"[+] [{store_name}] Page {pt}: Synced {saved} units | Prices: {valid_prices}/{len(cars)} | Photos: {valid_photos}/{len(cars)}")
                    await asyncio.sleep(1)

            total_synced_all += user_units_synced
            print(f"[✓] Completed crawl for {store_name}: {user_units_synced} units synced.")

        await browser.close()
    print(f"\n[✓] Global scraper run completed. Total units synced across all users: {total_synced_all}")

if __name__ == "__main__":
    asyncio.run(run_scraper())
