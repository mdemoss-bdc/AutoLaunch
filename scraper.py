import asyncio
import json
import os
import re
import sys
from typing import List, Dict, Any, Optional
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
    # Progressive smooth scrolling to trigger all lazy-loaded image listeners across DealerOn, Dealer.com, CDK, Inspire
    scroll_height = await page.evaluate("document.body.scrollHeight")
    step = max(350, int(scroll_height / 10))
    for y in range(0, scroll_height, step):
        await page.evaluate(f"window.scrollTo(0, {y})")
        await asyncio.sleep(0.15)
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    await asyncio.sleep(1.0)

    vehicles = await page.evaluate("""(defaultCond) => {
        const results = [];
        const seenVins = new Set();

        // -------------------------------------------------------------
        // STRATEGY 1: SCHEMA.ORG / JSON-LD (Standard across 90%+ Dealer Sites)
        // -------------------------------------------------------------
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

                                const make = (typeof item.brand === 'object' ? (item.brand.name || '') : (item.brand || item.manufacturer || '')).trim() || 'Other';
                                const model = (item.model || '').trim() || 'Vehicle';
                                const mileage = item.mileageFromOdometer ? parseInt(String(item.mileageFromOdometer.value || item.mileageFromOdometer).replace(/[^0-9]/g, '')) : null;

                                results.push({
                                    vin: vin.toUpperCase(),
                                    year: year || 2026,
                                    make: make,
                                    model: model,
                                    trim: '',
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
                                    dealership_id: "moses",
                                    is_active: true
                                });
                            }
                        }
                    });
                } catch(e) {}
            });
        } catch(e) {}

        // If JSON-LD populated vehicles, return them immediately
        if (results.length > 0) {
            return results;
        }

        // -------------------------------------------------------------
        // STRATEGY 2: UNIVERSAL DOM PARSER
        // Supports Dealer.com, DealerOn, CDK, Dealer Inspire, DealerSocket
        // -------------------------------------------------------------
        const cardSelectors = [
            // CDK / Sincro & Dealer.com
            '.vehicle-card', '.inventory-item', '.vehicle-overview', '.vehicle-item',
            // DealerOn
            '.inventory-list-item', '.vehicleListCard', '.vehicleCard', '.v-card',
            // Dealer Inspire
            '.inventory-vehicle', '.vehicle-list-item', '.vehicleCard',
            // Generic fallback
            '[data-vin]', '.listing-card', 'div[class*="inventory-card"]', 'div[class*="vehicle-card"]'
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

            // 2. HIGH-RES VEHICLE PHOTO
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

            // 3. SELLING PRICE ACROSS ALL CMS ENGINES
            let price = null;

            // Priority 1: Known Vendor Price Classes (DealerOn, CDK, Dealer.com, Dealer Inspire)
            const priceSelectors = [
                // Dealer.com & CDK
                '[class*="mosesPrice"]', '[class*="moses-price"]',
                '[class*="finalPrice"]', '[class*="final-price"]',
                '[class*="internetPrice"]', '[class*="internet-price"]',
                '[class*="salePrice"]', '[class*="sale-price"]',
                // DealerOn
                '.final-price .price-value', '.internet-price .price-value', '.selling-price',
                // Dealer Inspire
                '.normal-price .price', '.di-price', '.price-details .price',
                // Generic / Attributes
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

            // Priority 2: Structured Label Matching (Moses Price, Internet Price, Sale Price, Final Price)
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
                        // Check line directly above label
                        if (i > 0) {
                            const prevLine = lines[i - 1];
                            const prevMatch = prevLine.match(/\\$\\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/);
                            if (prevMatch) {
                                const val = parseInt(prevMatch[1].replace(/,/g, ''));
                                if (val >= 4000 && val <= 350000) {
                                    price = val;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            // Priority 3: Fallback to largest non-MSRP dollar amount on card
            if (!price) {
                const matches = Array.from(cardText.matchAll(/\\$\\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/g));
                for (const m of matches) {
                    const val = parseInt(m[1].replace(/,/g, ''));
                    if (val >= 4000 && val <= 350000) {
                        price = val;
                        break;
                    }
                }
            }

            // 4. DEALER / ROOFTOP LOCATION
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
            if (!exactLocation) exactLocation = "Moses Automotive Group";

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
                    if (words.length > 1) {
                        detectedTrim = words.slice(1).join(' ').replace(/SE|LE|XLE|Sport|AWD|4WD|FWD/gi, '').trim();
                    }
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
            else if (/Coupe|Mustang/i.test(cardText)) bodyType = "Coupe";
            else if (/Van|Minivan|Odyssey|Sienna|Pacifica/i.test(cardText)) bodyType = "Van";

            results.push({
                vin: vin.toUpperCase(),
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
