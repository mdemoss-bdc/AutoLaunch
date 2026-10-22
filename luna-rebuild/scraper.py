import asyncio
import json
import os
import re
import sys
from typing import List
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse
from playwright.async_api import async_playwright
from supabase import create_client

# =============================================================================
# NOTES (2026-10-22)
# - PHOTOS: scraped_inventory.photos (jsonb, added 2026-10-22) holds up to 20
#   gallery URLs per vehicle, hero first, each rewritten to the hi-res
#   width=1600 form. SRP cards only ever expose ONE photo, so after each SRP
#   page is extracted the scraper fetches every vehicle's VDP (raw HTML via
#   the browser context — DealerOn serves the full gallery server-side) and
#   harvests the gallery from the /inventoryphotos/<dealer>/<vin>/ip/N.jpg
#   sequence. image_url is kept equal to photos[0] for backward compat, and
#   the extension already flows `photos` through its select-* car fetch.
# - PRICE RULE (Matthew, 2026-10-22 15:36 EDT; supersedes the morning's
#   retail choice): store the ADVERTISED FINAL price (DealerOn's featured
#   "Moses Price" = retail - savings + doc fee), never the retail line.
#   Extraction keys off the featured-price element (.vehiclePricingHighlight-
#   Amount) and stack position (final total = last price row), not labels.
#   The VDP JSON-LD offers.price is that same final price and overrides the
#   SRP value when the VDP is fetched. Acceptance: Sentra -> 11222,
#   Tucson -> 11327.
# =============================================================================

SUPABASE_URL = os.environ.get("SUPABASE_URL") or "https://tdsipiltwajwhzgjsupx.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_KEY") or "sb_publishable_hkEU-TniEPk-ShSxBZQ-kQ_zGrDUC8w"
USER_ID = os.environ.get("USER_ID")

db = create_client(SUPABASE_URL, SUPABASE_KEY)

MAX_PAGES_PER_FEED = 500

# Test mode: SCRAPE_LIMIT caps how many vehicles are synced per user in one
# run (0 = no cap, normal production behavior). A capped run is a SAMPLE —
# it must never trigger the stale-inventory pass, because it deliberately
# did not see the dealer's whole lot.
try:
    SCRAPE_LIMIT = int(os.environ.get("SCRAPE_LIMIT") or 0)
except ValueError:
    SCRAPE_LIMIT = 0

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
                let modelOut = m[3].charAt(0).toUpperCase() + m[3].slice(1).toLowerCase();
                let trimOut = (m[4] || '');
                const mu = m[3].toUpperCase();
                // Hyphenated models are split by the regex above: the model
                // token stops at the hyphen and the rest lands in trim.
                // Re-join the known ones: HR-V, CR-V, CX-5/50/90, F-150/250/350
                if ((mu === 'HR' || mu === 'CR') && /^V($|-)/i.test(trimOut)) {
                    modelOut = mu + '-V';
                    trimOut = trimOut.slice(1).replace(/^-/, '');
                } else if ((mu === 'CX' || mu === 'F') && /^\d/.test(trimOut)) {
                    const dm = trimOut.match(/^(\d+)(?:-(.*))?$/);
                    if (dm) { modelOut = mu + '-' + dm[1]; trimOut = dm[2] || ''; }
                }
                return {
                    year: parseInt(m[1]),
                    make: m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase(),
                    model: modelOut,
                    trim: trimOut.replace(/SUV|Sedan|Truck|Coupe/gi, '').trim()
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
                                    if (offer) {
                                        // Dealer platforms bury the price in different spots:
                                        // offers.price, offers.priceSpecification(.price), AggregateOffer.lowPrice
                                        let rawPrice = offer.price;
                                        if (rawPrice == null && offer.priceSpecification) {
                                            const spec = Array.isArray(offer.priceSpecification) ? offer.priceSpecification[0] : offer.priceSpecification;
                                            if (spec) rawPrice = spec.price;
                                        }
                                        if (rawPrice == null && offer.lowPrice != null) rawPrice = offer.lowPrice;
                                        if (rawPrice != null) {
                                            const p = parseInt(String(rawPrice).replace(/[^0-9]/g, ''));
                                            if (p >= 1000 && p <= 350000) price = p;
                                        }
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

        if (results.length > 0) {
            // PRICE FILL PASS: JSON-LD often has VIN/stock/miles but no usable price
            // (Moses/DealerOn hides it in the visible card). For any result still
            // missing a price, find its card in the DOM by VIN and read the price there.
            const missingPrice = results.filter(r => !r.price);
            if (missingPrice.length > 0) {
                const fillSelectors = [
                    '[class*="mosesPrice"]', '[class*="moses-price"]',
                    '[class*="finalPrice"]', '[class*="final-price"]',
                    '[class*="internetPrice"]', '[class*="internet-price"]',
                    '[class*="salePrice"]', '[class*="sale-price"]',
                    '.final-price .price-value', '.internet-price .price-value', '.selling-price',
                    '.normal-price .price', '.di-price', '.price-details .price',
                    '[data-price]', '[itemprop="price"]', '.primary-price', '.price-value', '.value'
                ];
                const fillCards = document.querySelectorAll('.vehicle-card, .inventory-item, .vehicle-overview, .vehicle-item, .inventory-list-item, .vehicleListCard, .vehicleCard, .v-card, .inventory-vehicle, .vehicle-list-item, [data-vin], .listing-card, div[class*="inventory-card"], div[class*="vehicle-card"]');
                const priceByVin = {};
                fillCards.forEach(card => {
                    const txt = card.innerText || "";
                    const vm = txt.match(/\\b([A-HJ-NPR-Z0-9]{17})\\b/i) || (card.getAttribute('data-vin') || "").match(/([A-HJ-NPR-Z0-9]{17})/i);
                    if (!vm) return;
                    const vinKey = vm[1].toUpperCase();
                    if (priceByVin[vinKey]) return;
                    let p = null;
                    for (const sel of fillSelectors) {
                        const el = card.querySelector(sel);
                        if (el) {
                            const dataP = el.getAttribute('data-price') || el.getAttribute('content');
                            if (dataP && parseInt(dataP) >= 1000) { p = parseInt(dataP); break; }
                            if (el.innerText) {
                                const num = parseInt(el.innerText.replace(/[^0-9]/g, ''));
                                if (num >= 1000 && num <= 350000) { p = num; break; }
                            }
                        }
                    }
                    if (!p) {
                        const lines = txt.split('\\n').map(l => l.trim()).filter(Boolean);
                        for (const line of lines) {
                            if (/per mo|\\/mo|down|discount|savings|rebate|doc fee|estimate/i.test(line)) continue;
                            if (/price|final|sale|internet|selling|our price|market price/i.test(line)) {
                                const m = line.match(/\\$\\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/);
                                if (m) {
                                    const val = parseInt(m[1].replace(/,/g, ''));
                                    if (val >= 1000 && val <= 350000) { p = val; break; }
                                }
                            }
                        }
                    }
                    if (p) priceByVin[vinKey] = p;
                });
                missingPrice.forEach(r => { if (priceByVin[r.vin]) r.price = priceByVin[r.vin]; });
            }
            return results;
        }

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
                // DealerOn (Moses) price stack: big emphasized number inside the price block
                '.vehiclePricingStack .do-price-emphasis', '.priceBlockItemPrice .do-price-emphasis',
                '.do-price-emphasis', '[class*="priceBlockItemPrice"]',
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
                // Text fallback, 3 passes. Dealer cards print price in stacks like
                // "$11,222" on its own line with "Moses Price" on the NEXT line —
                // a same-line label+amount search can never see those.
                const lines = cardText.split('\\n').map(l => l.trim()).filter(Boolean);
                const moneyIn = (s) => {
                    const m = s.match(/\\$\\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/);
                    if (!m) return null;
                    const v = parseInt(m[1].replace(/,/g, ''));
                    return (v >= 1000 && v <= 350000) ? v : null;
                };
                const skipLine = (s) => /per mo|\\/mo|down payment|discount|savings|rebate|doc fee|estimate|payment/i.test(s);
                // Pass 1: label and amount on the same line
                for (const line of lines) {
                    if (skipLine(line)) continue;
                    if (/price|final|sale|internet|selling|our price|market price/i.test(line)) {
                        const v = moneyIn(line);
                        if (v) { price = v; break; }
                    }
                }
                // Pass 2: label line, amount on one of the next 2 lines
                if (!price) {
                    for (let i = 0; i < lines.length && !price; i++) {
                        if (skipLine(lines[i])) continue;
                        if (/price|final|sale|internet|selling|market/i.test(lines[i]) && !moneyIn(lines[i])) {
                            for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
                                if (skipLine(lines[j])) continue;
                                const v = moneyIn(lines[j]);
                                if (v) { price = v; break; }
                            }
                        }
                    }
                }
                // Pass 3: first standalone money line in the card (the big headline price)
                if (!price) {
                    for (const line of lines) {
                        if (skipLine(line)) continue;
                        if (/^\\$\\s*[0-9]{1,3}(?:,[0-9]{3})+$/.test(line) || /^\\$\\s*[0-9]{4,6}$/.test(line)) {
                            const v = moneyIn(line);
                            if (v) { price = v; break; }
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

# Safety brake for the stale pass: if a single run would deactivate more than
# this fraction of a dealer's active inventory, something is probably wrong
# with the feed itself, so we skip stale marking and log instead.
STALE_MAX_FRACTION = 0.5

def mark_stale_inventory(uid: str, seen_vins: set) -> int:
    """Flag inventory that a fully successful crawl did not see.

    Uses only fields the scraper already writes (is_active, status):
    stale rows get is_active=False and their status is left untouched
    (a car that left the feed is not necessarily "Sold"). If the same VIN
    reappears in a later crawl, the normal upsert reactivates it
    (is_active=True, status="Available").

    Returns the number of rows flagged. Any database error (for example if
    is_active somehow does not exist in this project's schema) is logged
    and swallowed so a stale-pass failure can never break the scrape.
    """
    if not uid or not seen_vins:
        return 0
    try:
        active_vins = []
        page_size = 1000
        offset = 0
        while True:
            res = (
                db.table("scraped_inventory")
                .select("vin")
                .eq("user_id", uid)
                .eq("is_active", True)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            rows = res.data or []
            active_vins.extend(r["vin"] for r in rows if r.get("vin"))
            if len(rows) < page_size:
                break
            offset += page_size

        stale = [v for v in active_vins if v not in seen_vins]
        if not stale:
            return 0

        if len(active_vins) >= 20 and len(stale) > STALE_MAX_FRACTION * len(active_vins):
            print(
                f"[!] Stale pass skipped for user {uid[:8]}: {len(stale)} of "
                f"{len(active_vins)} active units unseen (> {int(STALE_MAX_FRACTION * 100)}%). "
                "Feed may have changed; refusing to mass-deactivate."
            )
            return 0

        flagged = 0
        for i in range(0, len(stale), 200):
            chunk = stale[i:i + 200]
            db.table("scraped_inventory").update(
                {"is_active": False}
            ).eq("user_id", uid).in_("vin", chunk).execute()
            flagged += len(chunk)
        print(f"[✓] Stale pass for user {uid[:8]}: flagged {flagged} unseen unit(s) inactive.")
        return flagged
    except Exception as e:
        print(f"[!] Stale pass warning (non-fatal): {e}")
        return 0
# ==============================================================================
# ====================== SCRAPER ENTRYPOINT START ==============================
# ==============================================================================

async def run_scraper():

    active_job_id = None

    target_uid = os.environ.get("USER_ID")

    print(f"USER_ID => {target_uid}")

    if SCRAPE_LIMIT:

        print(f"[*] TEST MODE: SCRAPE_LIMIT={SCRAPE_LIMIT} vehicles per user. Stale pass disabled for capped runs.")

    if target_uid and target_uid.strip():

        pending_job = (
            db.table("scrape_jobs")
            .select("*")
            .eq("user_id", target_uid.strip())
            .eq("status", "pending")
            .execute()
        )

        print(
            f"PENDING JOBS FOUND => {len(pending_job.data or [])}"
        )

        if pending_job.data:

            latest_job = max(
                pending_job.data,
                key=lambda x: x["started_at"]
            )

            active_job_id = latest_job["id"]

        print(
            f"ACTIVE_JOB_ID => {active_job_id}"
        )

        res = (
            db.table("user_settings")
            .select("*")
            .eq("user_id", target_uid.strip())
            .execute()
        )

        users_to_scrape = res.data or []

    else:

        res = (
            db.table("user_settings")
            .select("*")
            .execute()
        )

        users_to_scrape = res.data or []

    if not users_to_scrape:

        print(
            "[-] No user accounts with configured dealership settings found."
        )

        return

    print(
        f"[*] Found {len(users_to_scrape)} account(s) registered in database."
    )

    total_synced_all = 0

    async with async_playwright() as p:

        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage"
            ]
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

            store_name = (
                user_cfg.get("dealership_name")
                or user_cfg.get("store_name")
                or "User Store"
            )

            page_modifier = (
                user_cfg.get("page_modifier")
                or "?pt={page}"
            )

            feeds_to_crawl = []

            if user_cfg.get("used_url") and user_cfg.get("used_url").strip():
                feeds_to_crawl.append({
                    "url": user_cfg["used_url"].strip(),
                    "condition": "Used"
                })

            if user_cfg.get("certified_url") and user_cfg.get("certified_url").strip():
                feeds_to_crawl.append({
                    "url": user_cfg["certified_url"].strip(),
                    "condition": "Certified Pre-Owned"
                })

            if user_cfg.get("new_url") and user_cfg.get("new_url").strip():
                feeds_to_crawl.append({
                    "url": user_cfg["new_url"].strip(),
                    "condition": "New"
                })

            if not feeds_to_crawl:

                print(
                    f"[-] Skipping User {active_uid[:8]} ({store_name}): No inventory URLs entered yet."
                )

                continue

            print("\n=======================================================")
            print(f"[*] Crawling for User: {active_uid}")
            print(f"[*] Store: {store_name}")
            print("=======================================================")
            user_units_synced = 0
            # Stale tracking for this user: every VIN seen across all feeds,
            # and whether the crawl stayed clean enough to trust a stale pass.
            user_seen_vins = set()
            user_had_error = False

            for feed in feeds_to_crawl:

                if SCRAPE_LIMIT and user_units_synced >= SCRAPE_LIMIT:

                    print(
                        f"[*] SCRAPE_LIMIT of {SCRAPE_LIMIT} reached. Skipping remaining feeds for this user."
                    )

                    break

                base_url = feed["url"]
                condition = feed["condition"]

                print(
                    f"[*] Crawling feed: {condition} -> {base_url}"
                )

                seen_vins = set()

                for pt in range(1, MAX_PAGES_PER_FEED + 1):

                    url = build_page_url(
                        base_url,
                        page_modifier,
                        pt
                    )

                    try:

                        response = await page.goto(
                            url,
                            wait_until="commit",
                            timeout=30000
                        )

                        if response and response.status == 404:

                            print(
                                f"[!] 404 Page Not Found: {url}"
                            )

                            if pt == 1:
                                # Feed URL itself is broken: do not trust
                                # this run for stale marking.
                                user_had_error = True

                            break

                    except Exception as e:

                        print(
                            f"[!] Navigation error: {e}"
                        )

                        user_had_error = True

                    await asyncio.sleep(2)

                    try:

                        cars = await extract_cards_from_page(
                            page,
                            default_condition=condition,
                            active_uid=active_uid
                        )

                    except Exception as e:

                        print(
                            f"[!] Extraction error on {url}: {e}"
                        )

                        user_had_error = True

                        break

                    if not cars:

                        print(
                            f"[-] No cards found on page {pt}. Finished {condition}."
                        )

                        break

                    if SCRAPE_LIMIT:

                        remaining = SCRAPE_LIMIT - user_units_synced

                        if remaining <= 0:

                            print(
                                f"[*] SCRAPE_LIMIT of {SCRAPE_LIMIT} reached for this user. Stopping test crawl."
                            )

                            break

                        if len(cars) > remaining:

                            cars = cars[:remaining]

                    vins = {
                        c["vin"]
                        for c in cars
                        if c.get("vin")
                    }

                    if vins.issubset(seen_vins):

                        print(
                            f"[-] Duplicate batch on page {pt}. Finished {condition}."
                        )

                        break

                    seen_vins.update(vins)

                    user_seen_vins.update(vins)

                    saved = push_batch_to_supabase(cars)

                    user_units_synced += saved

                    print(
                        f"[+] [{store_name}] Page {pt}: Synced {saved} units"
                    )

                    await asyncio.sleep(1)

            total_synced_all += user_units_synced

            # Stale pass: only after a fully clean crawl that actually saw
            # cars. Any navigation/extraction error, or an empty result,
            # means "we don't know" — and "don't know" never deactivates
            # a dealer's inventory.
            if SCRAPE_LIMIT:

                print(
                    f"[!] Stale pass skipped for {store_name}: capped test run (SCRAPE_LIMIT={SCRAPE_LIMIT}) never deactivates inventory."
                )

            elif user_seen_vins and not user_had_error:

                mark_stale_inventory(active_uid, user_seen_vins)

            elif user_seen_vins and user_had_error:

                print(
                    f"[!] Stale pass skipped for {store_name}: crawl had errors."
                )

            print(
                f"[✓] Completed crawl for {store_name}: {user_units_synced} units synced."
            )

        await browser.close()

    if active_job_id:

        try:

            db.table("scrape_jobs").update({
                "status": "completed",
                "completed_at": datetime.now(
                    timezone.utc
                ).isoformat(),
                "cars_synced": total_synced_all
            }).eq(
                "id",
                active_job_id
            ).execute()

            print(
                f"[✓] Job {active_job_id} marked completed."
            )

        except Exception as e:

            print(
                f"[!] Could not update scrape job: {e}"
            )

    print(
        f"\n[✓] Global scraper run completed. Total units synced across all users: {total_synced_all}"
    )

# ==============================================================================
# ====================== SCRAPER ENTRYPOINT END ================================
# ==============================================================================

if __name__ == "__main__":
    asyncio.run(run_scraper())
