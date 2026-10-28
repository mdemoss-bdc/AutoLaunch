import asyncio
import json
import os
import re
import sys
from typing import List
from datetime import datetime, timedelta, timezone
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

db = create_client(SUPABASE_URL, SUPABASE_KEY)

MAX_PAGES_PER_FEED = 500
MAX_SCROLL_ROUNDS = 40  # infinite-scroll harvest cap per page (2026-10-23)

# Test mode: SCRAPE_LIMIT caps how many vehicles are synced per user in one
# run (0 = no cap, normal production behavior). A capped run is a SAMPLE —
# it must never trigger the stale-inventory pass, because it deliberately
# did not see the dealer's whole lot.
try:
    SCRAPE_LIMIT = int(os.environ.get("SCRAPE_LIMIT") or 0)
except ValueError:
    SCRAPE_LIMIT = 0

# Sync modes (Matthew, 2026-10-23): a capped run belongs ONLY to the
# account-setup test phase. Every scrape_jobs row carries sync_mode:
# 'test' (setup, capped at TEST_SYNC_LIMIT so the dealer sees a fast
# proof) or 'full' (the Sync Inventory button once setup has succeeded
# — uncapped). When a run serves a pending job, the job's mode decides
# the cap and overrides the SCRAPE_LIMIT env, because the dispatch
# workflow passes its capped default (15) on every app-triggered run.
# Manual Actions runs with no pending job keep honoring the env input
# exactly as before (0 = the full refill Matthew runs by hand).
TEST_SYNC_LIMIT = 15

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
    # INFINITE-SCROLL HARVEST (2026-10-23): scroll stepwise to the bottom,
    # click any Load More / Show More button, then keep going while the
    # page keeps growing (height or card count still changing). Stop after
    # 2 stable rounds or at MAX_SCROLL_ROUNDS. Paginated sites stabilize
    # immediately, so their behavior is unchanged apart from ~2 extra
    # confirmation scrolls per page.
    last_sig = None
    stable_rounds = 0
    for _round in range(MAX_SCROLL_ROUNDS):
        scroll_height = await page.evaluate("document.body.scrollHeight")
        step = max(350, int(scroll_height / 10))
        for y in range(0, scroll_height, step):
            await page.evaluate(f"window.scrollTo(0, {y})")
            await asyncio.sleep(0.12)
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        try:
            await page.evaluate("""() => {
                const btns = Array.from(document.querySelectorAll('button, a'));
                const b = btns.find(el => /load more|show more|view more/i.test(el.innerText || '') && el.offsetParent !== null);
                if (b) { b.click(); return true; }
                return false;
            }""")
        except Exception:
            pass
        await asyncio.sleep(1.2)
        try:
            sig = await page.evaluate("""() => document.body.scrollHeight + ':' + document.querySelectorAll('[data-vin], .vehicle-card, .inventory-item, .vehicle-overview, .vehicle-item, .inventory-list-item, .vehicleListCard, .vehicleCard, .v-card, .inventory-vehicle, .vehicle-list-item, .listing-card').length""")
        except Exception:
            sig = None
        if sig is not None and sig == last_sig:
            stable_rounds += 1
            if stable_rounds >= 2:
                break
        else:
            stable_rounds = 0
            last_sig = sig

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
            // DealerOn writes word separators two ways: hyphens in most
            // slugs, '+' in others (CR+V, Grand+Cherokee, Santa+Fe,
            // F+150) — and the CITY segment can itself contain a '+'
            // ("St+Albans"), so the tail after the make is tokenized
            // on BOTH separators instead of normalizing the whole URL
            // (normalizing broke the hyphen-free city match). Without
            // this, those models truncated to their first fragment in
            // the database ("Cr", "Grand", "Super", "F", "Santa").
            // Matches formats like:
            // /used-Huntington-2020-Lincoln-NAUTILUS-SUV-2LMPJ8K94LBL05090
            const m = url.match(/(?:used|new|cpo|certified)-[^-]+-(\\d{4})-([A-Za-z0-9]+)-(.+?)(?:\\?.*)?$/i);
            if (!m) return null;
            const titleWord = w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
            let makeOut = titleWord(m[2]);
            if (m[2].toUpperCase() === 'GMC') makeOut = 'GMC';
            const tokens = m[3].split(/[-+]/).filter(Boolean);
            if (!tokens.length) return null;
            let modelOut = titleWord(tokens[0]);
            let rest = tokens.slice(1);
            const mu = tokens[0].toUpperCase();
            // Hyphenated models are split by the tokenizer: the model
            // token stops at the hyphen and the rest lands in trim.
            // Re-join the known ones: HR-V, CR-V, CX-5/50/90, F-150/250/350
            if ((mu === 'HR' || mu === 'CR') && rest.length && /^V$/i.test(rest[0])) {
                modelOut = mu + '-V';
                rest = rest.slice(1);
            } else if ((mu === 'CX' || mu === 'F') && rest.length && /^\d+(SD)?$/i.test(rest[0])) {
                // Ford writes the Super Duty token two ways: "F-250"
                // (pure digits) and "F+250SD" (digits + SD suffix,
                // University Ford's slugs). Both mean model F-250 —
                // without the SD allowance the model truncates to "F".
                modelOut = mu + '-' + rest[0].replace(/SD$/i, '');
                rest = rest.slice(1);
            }
            // Two-word models the first-token rule can never see whole.
            const TWO_WORD = {
                'GRAND CHEROKEE': 'Grand Cherokee', 'GRAND WAGONEER': 'Grand Wagoneer',
                'GRAND HIGHLANDER': 'Grand Highlander', 'GRAND CARAVAN': 'Grand Caravan',
                'SANTA FE': 'Santa Fe', 'SANTA CRUZ': 'Santa Cruz',
                'LAND CRUISER': 'Land Cruiser', 'SUPER DUTY': 'Super Duty',
                'TRANSIT CONNECT': 'Transit Connect'
            };
            if (rest.length) {
                const pair = mu + ' ' + rest[0].toUpperCase();
                if (TWO_WORD[pair]) { modelOut = TWO_WORD[pair]; rest = rest.slice(1); }
            }
            // Super Duty trucks carry their F-code inside the model name.
            if (modelOut === 'Super Duty' && rest.length >= 2 && /^F$/i.test(rest[0]) && /^\d+$/.test(rest[1])) {
                modelOut = 'Super Duty F-' + rest[1];
                rest = rest.slice(2);
            }
            // Badge casing the title-caser mangles (Rav4 -> RAV4 etc.).
            const MODEL_CASE = {
                'RAV4': 'RAV4', '4RUNNER': '4Runner', 'RX': 'RX', 'TX': 'TX',
                'NX': 'NX', 'GX': 'GX', 'LX': 'LX', 'UX': 'UX', 'ES': 'ES',
                'IS': 'IS', 'LS': 'LS', 'RC': 'RC', 'MDX': 'MDX', 'RDX': 'RDX',
                'ZDX': 'ZDX', 'ADX': 'ADX', 'TLX': 'TLX', 'ILX': 'ILX',
                'CT4': 'CT4', 'CT5': 'CT5', 'XT4': 'XT4', 'XT5': 'XT5', 'XT6': 'XT6',
                'XC40': 'XC40', 'XC60': 'XC60', 'XC90': 'XC90',
                'GV60': 'GV60', 'GV70': 'GV70', 'GV80': 'GV80',
                'GR86': 'GR86', 'MKZ': 'MKZ', 'NV': 'NV', 'BZ4X': 'bZ4X',
                'IX': 'iX', 'I7': 'i7', 'XM': 'XM'
            };
            if (MODEL_CASE[modelOut.toUpperCase()]) modelOut = MODEL_CASE[modelOut.toUpperCase()];
            return {
                year: parseInt(m[1]),
                make: makeOut,
                model: modelOut,
                trim: rest.join('-').replace(/SUV|Sedan|Truck|Coupe/gi, '').trim()
            };
        }

        // FINAL-PRICE HELPER (price rule, 2026-10-22): the stored price is the
        // dealer's ADVERTISED FINAL price (DealerOn's featured price, e.g.
        // "Moses Price" = retail - savings + doc fee), never the retail line.
        // Key off the featured-price element + stack position, not label text:
        // 1) .vehiclePricingHighlightAmount (the big featured headline figure)
        // 2) the LAST .priceBlockItemPrice row in the stack (the final total
        //    sits last; retail/doc/savings are the rows above it)
        // Returns null when neither is present so callers fall back.
        function finalPriceFromStack(scope) {
            const money = (s) => {
                if (!s) return null;
                const m = String(s).replace(/&#x2B;/g, '+').match(/\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})/);
                if (!m) return null;
                const v = parseInt(m[1].replace(/,/g, ''));
                return (v >= 1000 && v <= 350000) ? v : null;
            };
            try {
                // New-car cards/pages render TWO highlight amounts: the
                // SAVINGS figure first, the price second (2026-10-23 fix).
                // Take the LARGEST highlight in scope, never the first.
                const feats = scope.querySelectorAll('.vehiclePricingHighlightAmount, [class*="vehiclePricingHighlightAmount"]');
                let bestFeat = null;
                feats.forEach(el => {
                    const v = money(el.innerText || el.textContent);
                    if (v && (!bestFeat || v > bestFeat)) bestFeat = v;
                });
                if (bestFeat) return bestFeat;
                const feat = null;
                const featLi = scope.querySelector('.priceBlockItemFeaturedPrice, [class*="FeaturedPrice"]');
                if (featLi && !feat) {
                    const v = money(featLi.innerText || featLi.textContent);
                    if (v) return v;
                }
                const rows = scope.querySelectorAll('.vehiclePricingStack .priceBlockItemPrice, .priceBlock .priceBlockItemPrice, [class*="priceBlockItemPrice"]');
                if (rows && rows.length > 0) {
                    for (let i = rows.length - 1; i >= 0; i--) {
                        const row = rows[i];
                        // Skip adjustment rows (doc fee / savings / discount) —
                        // the final total is the last NON-adjustment row.
                        const lbl = row.querySelector('[class*="priceBlocItemPriceLabel"], [class*="PriceLabel"]');
                        const lblTxt = lbl ? (lbl.innerText || '') : '';
                        if (/doc fee|savings|discount|rebate/i.test(lblTxt)) continue;
                        const valEl = row.querySelector('[class*="priceBlocItemPriceValue"], [class*="PriceValue"], .do-price-emphasis');
                        const v = money(valEl ? (valEl.innerText || valEl.textContent) : (row.innerText || row.textContent));
                        if (v) return v;
                    }
                }
            } catch (e) {}
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
                                    photos: image ? [image] : [],
                                    interior_color: null,
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
                    // Advertised FINAL price first (featured element / last
                    // stack row) — the generic selectors below see the retail
                    // row first and must not win over it.
                    let p = finalPriceFromStack(card);
                    if (!p) for (const sel of fillSelectors) {
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

            // 4. PRICE EXTRACTION — advertised FINAL price (featured element /
            // last stack row) wins; generic selectors are only a fallback.
            let price = finalPriceFromStack(card);
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

            if (!price) for (const sel of priceSelectors) {
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
                // Pass 1: label and amount on the same line. Retail/MSRP lines
                // are skipped here so the stack's final-price line wins; a
                // retail-only card is still caught by passes 2 and 3.
                for (const line of lines) {
                    if (skipLine(line)) continue;
                    if (/retail|msrp|list price/i.test(line)) continue;
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
                        // Two-word models (Grand Cherokee, Santa Fe…)
                        const TWO_WORD_TITLES = ['Grand Cherokee', 'Grand Wagoneer', 'Grand Highlander', 'Grand Caravan', 'Santa Fe', 'Santa Cruz', 'Land Cruiser', 'Super Duty', 'Transit Connect'];
                        if (words.length > 1 && TWO_WORD_TITLES.some(t => t.toLowerCase() === (words[0] + ' ' + words[1]).toLowerCase())) {
                            detectedModel = words[0] + ' ' + words[1];
                            words.splice(1, 1);
                        }
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
            // New-car default (Matthew, 2026-10-23): when the site
            // publishes no mileage for a NEW vehicle, store 1,000 —
            // Facebook's form refuses anything under 300, and the
            // old placeholder (5) got brand-new listings blocked.
            // The extension discloses in the listing description
            // that a defaulted figure means actual miles may be
            // less. Real published mileage always wins.
            const mileMatch = cardText.match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,6})\\s*(?:miles|mi\\b)/i);
            const mileage = mileMatch ? parseInt(mileMatch[1].replace(/,/g, '')) : (defaultCond === "New" ? 1000 : null);

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
                price_status: price ? null : (/call\s+for\s+price/i.test(cardText) ? "call" : "none"),
                mileage: mileage,
                location_name: exactLocation,
                image_url: photoUrl,
                photos: photoUrl ? [photoUrl] : [],
                interior_color: null,
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

    # Preserve a numeric price already stored when this scrape found none.
    # This protects a price the user typed in manually for a Call for
    # Price / unpriced vehicle. When a later scrape DOES find a numeric
    # dealer price, that new value replaces the stored one automatically.
    try:
        missing_by_user = {}
        for r in unique_by_vin.values():
            if not r.get("price") and r.get("user_id"):
                missing_by_user.setdefault(r["user_id"], []).append(r["vin"])
        for uid, vins in missing_by_user.items():
            existing_prices = {}
            for i in range(0, len(vins), 200):
                chunk = vins[i:i + 200]
                res = (
                    db.table("scraped_inventory")
                    .select("vin, price")
                    .eq("user_id", uid)
                    .in_("vin", chunk)
                    .execute()
                )
                for row in res.data or []:
                    if row.get("price"):
                        existing_prices[row["vin"]] = row["price"]
            for r in unique_by_vin.values():
                if (
                    r.get("user_id") == uid
                    and not r.get("price")
                    and r.get("vin") in existing_prices
                ):
                    r["price"] = existing_prices[r["vin"]]
    except Exception as e:
        print(f"[!] Existing-price preservation warning (non-fatal): {e}")

    try:
        res = db.table("scraped_inventory").upsert(
            list(unique_by_vin.values()),
            on_conflict="vin, user_id"
        ).execute()
        return len(res.data) if res.data else 0
    except Exception as e:
        print(f"[!] Batch upsert error: {e}")
        return 0

# ==============================================================================
# ==================== VDP ENRICHMENT (photos + final price) ===================
# ==============================================================================
# SRP cards only ever expose ONE photo per vehicle and (on DealerOn) a price
# stack whose first row is RETAIL. The detail page (VDP) has both the full
# gallery and the advertised final price, and DealerOn serves them in the raw
# HTML, so a plain request per vehicle (via the browser context, sharing its
# UA/cookies) is enough — no extra page render.

MAX_PHOTOS_PER_VEHICLE = 20
VDP_FETCH_CONCURRENCY = 5


def hi_res_photo_url(url: str, add_width: bool = False) -> str:
    """Mirror of the app's hiResPhotoUrl(): rewrite a numeric width/w query
    param below 1600 up to 1600. Optionally append width=1600 when the photo
    service URL has no width param at all (DealerOn photo URLs accept it)."""
    if not url or not isinstance(url, str):
        return url
    try:
        parts = urlparse(url)
        pairs = parse_qsl(parts.query, keep_blank_values=True)
        out_pairs = []
        seen_width = False
        for k, v in pairs:
            if k.lower() in ("width", "w"):
                seen_width = True
                if v.isdigit() and int(v) < 1600:
                    out_pairs.append((k, "1600"))
                    continue
            out_pairs.append((k, v))
        if add_width and not seen_width:
            out_pairs.append(("width", "1600"))
        # safe=":" keeps the timestamp in the dealer's canonical literal form.
        return urlunparse(parts._replace(query=urlencode(out_pairs, safe=":")))
    except Exception:
        return url


def _money_int(raw) -> int:
    """Parse a price-ish value ('$11,327', '11327.00', 11327) to int or None."""
    if raw is None:
        return None
    try:
        v = int(float(str(raw).replace("$", "").replace(",", "").strip()))
    except (TypeError, ValueError):
        return None
    return v if 1000 <= v <= 350000 else None


def _mileage_int(raw) -> int:
    """Parse an odometer value to int or None. Wider band than prices:
    a new car can legitimately show a few hundred miles (the VDP spec
    block once stored NULL for a 442-mile car because _money_int's
    price floor of 1,000 discarded it), and a high-mile trade can pass
    350k. Range sanity only: 0..2,000,000."""
    if raw is None:
        return None
    try:
        v = int(float(str(raw).replace(",", "").strip()))
    except (TypeError, ValueError):
        return None
    return v if 0 <= v <= 2000000 else None


def parse_vdp_details(html: str, vin: str, page_url: str) -> dict:
    """Extract gallery photos, advertised final price, and spec colors from a
    DealerOn VDP's raw HTML. Returns a dict; missing pieces stay None/[]."""
    out = {
        "photos": [],
        "price": None,
        "price_status": None,
        "price_is_final": False,
        "color": None,
        "interior_color": None,
        "body_type": None,
        "mileage": None,
    }
    if not html or not vin:
        return out

    vin_l = vin.lower()
    origin = ""
    if page_url:
        p = urlparse(page_url)
        if p.scheme and p.netloc:
            origin = f"{p.scheme}://{p.netloc}"

    # ---- PHOTOS: /inventoryphotos/<dealerId>/<vin>/ip/<n>.jpg sequence.
    # The /ip/thumbs/ variants (used for OTHER cars' cards) cannot match:
    # the pattern requires digits immediately after /ip/.
    found = {}
    pat = re.compile(
        r"((?:https?:)?//[^\s\"'<>,]+?/inventoryphotos/\d+/" + re.escape(vin_l) + r"/ip/(\d+)\.jpg(?:\?[^\s\"'<>,]+)?"
        r"|/inventoryphotos/\d+/" + re.escape(vin_l) + r"/ip/(\d+)\.jpg(?:\?[^\s\"'<>,]+)?)",
        re.IGNORECASE,
    )
    for m in pat.finditer(html):
        raw = (m.group(1) or "").replace("&amp;", "&").strip()
        num = int(m.group(2) or m.group(3))
        if raw.startswith("//"):
            raw = "https:" + raw
        elif raw.startswith("/"):
            raw = origin + raw
        if not raw.startswith("http"):
            continue
        prev = found.get(num)
        # Prefer the canonical URL carrying the timestamp query.
        if prev is None or ("timestamp=" in raw and "timestamp=" not in prev):
            found[num] = raw
    photos = []
    for num in sorted(found)[:MAX_PHOTOS_PER_VEHICLE]:
        u = hi_res_photo_url(found[num], add_width=True)
        if u and u not in photos:
            photos.append(u)

    # ---- JSON-LD: price / color / bodyType / fallback image list
    jsonld_price = None
    jsonld_images = []
    for m in re.finditer(
        r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I
    ):
        try:
            data = json.loads(m.group(1).strip())
        except Exception:
            continue
        if isinstance(data, list):
            items = data
        elif isinstance(data, dict) and isinstance(data.get("@graph"), list):
            items = data["@graph"]
        elif isinstance(data, dict):
            items = [data]
        else:
            items = []
        for item in items:
            if not isinstance(item, dict):
                continue
            t = str(item.get("@type") or "").lower()
            if t not in ("vehicle", "car", "product") and not item.get(
                "vehicleIdentificationNumber"
            ):
                continue
            off = item.get("offers")
            if isinstance(off, list):
                off = off[0] if off else None
            if isinstance(off, dict) and jsonld_price is None:
                p = off.get("price")
                if p is None and isinstance(off.get("priceSpecification"), dict):
                    p = off["priceSpecification"].get("price")
                if p is None:
                    p = off.get("lowPrice")
                jsonld_price = _money_int(p)
            img = item.get("image")
            if isinstance(img, str):
                jsonld_images.append(img)
            elif isinstance(img, list):
                for e in img:
                    if isinstance(e, str):
                        jsonld_images.append(e)
                    elif isinstance(e, dict) and e.get("url"):
                        jsonld_images.append(e["url"])
            elif isinstance(img, dict) and img.get("url"):
                jsonld_images.append(img["url"])
            if item.get("color") and not out["color"]:
                out["color"] = str(item["color"]).strip()
            if item.get("bodyType") and not out["body_type"]:
                out["body_type"] = str(item["bodyType"]).strip()
            odo = item.get("mileageFromOdometer")
            if odo is not None and out["mileage"] is None:
                if isinstance(odo, dict):
                    odo = odo.get("value")
                mv = _mileage_int(odo)
                if mv is not None:
                    out["mileage"] = mv

    # ---- MILEAGE fallback: the VDP spec block prints the figure
    # even when the SRP card regex missed it and the JSON-LD carries
    # no odometer (2026-10-23: a 2027 Sentra whose site publishes
    # 442 stored NULL — the SRP pattern required a comma group or
    # 4+ digits, so a bare "442 miles" never matched; the spec
    # block's "MILEAGE 442" has no "miles" suffix at all). First
    # label occurrence wins: the subject car's spec block precedes
    # the "Vehicles You Might Like" cross-sell.
    #
    # FIX (2026-10-28, REBUILD TREE ONLY — production root scraper.py
    # still carries the bug): the old pattern ran over RAW html, so
    # its first "MILEAGE" hit was the CSS selector `.mileage-icon`
    # inside the DealerOn <style> block, and the [^0-9]{0,120} bridge
    # landed on the "5" of the hex color #c5c5c5 in that rule —
    # mileage came out as 5 on ~99.9% of fallback-leg cars (proven
    # in scraper_next's step-1 shadow run, 2,322 of 2,324 cars).
    # The fallback now searches VISIBLE TEXT ONLY (script/style
    # stripped, tags flattened — same treatment as scraper_next's
    # _strip_to_text) with a tight label-to-value bridge, so the
    # match can only be the printed spec block.
    if out["mileage"] is None:
        vis = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
        vis = re.sub(r"<[^>]+>", " ", vis)
        vis = " ".join(vis.replace("&nbsp;", " ").split())
        mm = re.search(
            r"(?:MILEAGE|ODOMETER)[^0-9]{0,20}([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,6})",
            vis, re.I)
        if mm:
            out["mileage"] = int(mm.group(1).replace(",", ""))

    if not photos and jsonld_images:
        for u in jsonld_images:
            hu = hi_res_photo_url(u)
            if hu and hu.startswith("http") and hu not in photos:
                photos.append(hu)
            if len(photos) >= MAX_PHOTOS_PER_VEHICLE:
                break
    out["photos"] = photos

    # ---- PRICE: the featured headline element is the advertised final
    # price. On DealerOn pages the JSON-LD offers.price is that same final
    # price (verified: Tucson 11327, Sentra 11222), so JSON-LD counts as
    # final whenever the page carries the DealerOn pricing stack.
    # BUG FIX (2026-10-23): DealerOn renders MULTIPLE
    # .vehiclePricingHighlightAmount elements on new-car VDPs — the FIRST
    # is the "SAVINGS" highlight (a discount figure, e.g. $1,000), a later
    # one is the actual advertised price (e.g. $115,715). First-match
    # extraction stored the discount as the price on 339 new cars.
    # JSON-LD offers.price is the dealer's own structured final price
    # (verified against the stack on used + new) — trust it first; fall
    # back to the LARGEST highlight amount (the price dwarfs the savings).
    feat_amounts = [
        _money_int(m.group(1))
        for m in re.finditer(
            r"vehiclePricingHighlightAmount[^>]*>\s*\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})",
            html,
        )
    ]
    feat_amounts = [v for v in feat_amounts if v]
    feat_price = max(feat_amounts) if feat_amounts else None
    has_stack = (
        feat_price is not None
        or "vehiclePricingStack" in html
        or "priceBlockItemPrice" in html
    )
    if jsonld_price is not None:
        out["price"] = jsonld_price
        out["price_is_final"] = has_stack or bool(feat_amounts)
    elif feat_price:
        out["price"] = feat_price
        out["price_is_final"] = True

    if out["price"] is None:
        # LABEL FALLBACK (Matthew's rule, 2026-10-23): the stored price is
        # the dealer's ADVERTISED FINAL price, whatever they call it —
        # "Moses Price", "Glockner Price", "Internet Price", "Sale Price",
        # "Our Price", "Final Price", "Selling Price"... Scan visible text
        # lines for a price label carrying a $ amount; adjustment lines
        # (MSRP / retail / savings / discount / rebate / doc fee / payment /
        # estimate / trade) never qualify. The LAST qualifying line wins:
        # the final total sits at the bottom of the pricing stack.
        try:
            # Label and amount usually live in SEPARATE elements, so work
            # on the flattened text: a $ amount qualifies when a "price"
            # label sits within ~80 chars before it (or ~40 after) with no
            # adjustment word in between. Last qualifying amount wins.
            _text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S | re.I)
            _text = re.sub(r"<[^>]+>", " ", _text).replace("&nbsp;", " ")
            _text = re.sub(r"\s+", " ", _text)
            _bad = re.compile(r"msrp|retail|savings|discount|rebate|doc fee|payment|per mo|/mo|list price|estimate|trade", re.I)
            def _zone_ok(zone):
                # A zone qualifies when its LAST "price" mention comes
                # after its last adjustment word ("Doc Fee +$499 Glockner
                # Price" qualifies; "Moses Price ... MSRP:" does not).
                zl = zone.lower()
                p_idx = zl.rfind("price")
                if p_idx < 0:
                    return False
                b_idx = -1
                for _bm in _bad.finditer(zl):
                    b_idx = max(b_idx, _bm.start())
                return p_idx > b_idx
            _found = None
            _matches = list(re.finditer(r"\$\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})", _text))
            for _i, _m in enumerate(_matches):
                _v = _money_int(_m.group(1))
                if not _v:
                    continue
                # Label zone = text since the PREVIOUS $ amount (dense
                # stacks pack adjustments tightly; a wide window would
                # always contain an adjustment word and reject everything).
                _prev_end = _matches[_i - 1].end() if _i > 0 else 0
                _before = _text[max(_prev_end, _m.start() - 80):_m.start()]
                _next_start = _matches[_i + 1].start() if _i + 1 < len(_matches) else len(_text)
                _after = _text[_m.end():min(_next_start, _m.end() + 40)]
                if _zone_ok(_before) or _zone_ok(_after):
                    _found = _v
            if _found:
                out["price"] = _found
                out["price_is_final"] = True
        except Exception:
            pass

    # ---- PRICE STATUS (Matthew, 2026-10-23): distinguish a dealer that
    # deliberately publishes "Call for Price" from one that publishes no
    # price at all. Both states auto-clear on a later scrape when a real
    # numeric price appears.
    if out["price"] is not None:
        out["price_status"] = None
    else:
        _visible_text = re.sub(
            r"<script.*?</script>|<style.*?</style>", " ", html, flags=re.S | re.I
        )
        _visible_text = re.sub(r"<[^>]+>", " ", _visible_text)
        _visible_text = re.sub(r"\s+", " ", _visible_text)
        # Scope to THIS vehicle: DealerOn VDPs end with a "Vehicles You
        # Might Like" cross-sell whose cars are often Call for Price —
        # their state must never leak onto this car (verified live: the
        # Grand Highlander Platinum publishes no price at all, yet its
        # page mentions Call for Price 16 times, all in the cross-sell).
        _cut = len(_visible_text)
        for _marker in (
            "vehicles you might like",
            "you may also like",
            "similar vehicles",
            "recommended vehicles",
        ):
            _idx = _visible_text.lower().find(_marker)
            if 0 <= _idx < _cut:
                _cut = _idx
        _main_text = _visible_text[:_cut]
        out["price_status"] = (
            "call" if re.search(r"\bcall\s+for\s+price\b", _main_text, re.I) else "none"
        )

    # ---- SPEC LIST colors (DealerOn .info__value blocks), exterior first
    for label, key in (("Exterior Color", "color"), ("Interior Color", "interior_color")):
        if out[key]:
            continue
        m = re.search(
            re.escape(label)
            + r'</span>\s*<span class="info__value[^"]*"[^>]*>\s*([^<]+?)\s*</span>',
            html,
            re.S,
        )
        if m and m.group(1).strip():
            out[key] = m.group(1).strip()

    return out


async def enrich_cars_with_vdp(context, cars: List[dict]) -> int:
    """Fetch each car's VDP once and fill in the full photo gallery, the
    advertised final price, and spec colors. Any failure leaves the SRP
    values in place (photos fall back to the single SRP photo, hi-res).
    Returns how many cars got a multi-photo gallery."""
    sem = asyncio.Semaphore(VDP_FETCH_CONCURRENCY)
    enriched = 0

    async def one(car: dict):
        nonlocal enriched
        fallback = []
        if car.get("image_url"):
            fallback = [hi_res_photo_url(car["image_url"])]
        detail_url = car.get("detail_url")
        if not detail_url:
            if fallback:
                car["photos"] = fallback
            return
        html = None
        async with sem:
            try:
                resp = await context.request.get(detail_url, timeout=20000)
                if resp.status == 200:
                    html = await resp.text()
            except Exception:
                html = None
        if not html:
            if fallback:
                car["photos"] = fallback
            return
        d = parse_vdp_details(html, car.get("vin") or "", detail_url)
        if d["photos"]:
            car["photos"] = d["photos"]
            car["image_url"] = d["photos"][0]
            if len(d["photos"]) > 1:
                enriched += 1
        elif fallback:
            car["photos"] = fallback
        # Final price wins over the SRP stack value; a non-final VDP price
        # only fills a gap the SRP pass left empty.
        if d["price"] and (d["price_is_final"] or not car.get("price")):
            car["price"] = d["price"]
        # Guard (2026-10-23): a NEW car can never cost under $5,000 — a
        # value below that is an extractor artifact (a discount/payment
        # figure), never a price. Store None (honest "no price") instead.
        if (
            str(car.get("condition") or "").lower().startswith("new")
            and car.get("price")
            and car["price"] < 5000
        ):
            car["price"] = None
        # Keep the dealer-publication state current — with one
        # precedence correction (2026-10-23): a VDP that publishes
        # NO price (call/none) is authoritative over an SRP figure.
        # SRP cards carry teaser/payment numbers that are not the
        # advertised price (a Call-for-Price 2026 Sienna stored
        # $7,998 off its card and posted to Facebook at that
        # figure). When the car's own page says no price is
        # published, there is no price — the app will ask the user
        # to type one (Matthew's no-price rule). Otherwise a numeric
        # price clears the state, and the VDP classification wins
        # over the SRP card's.
        if not d["price"] and d.get("price_status") in ("call", "none"):
            car["price"] = None
            car["price_status"] = d["price_status"]
        elif car.get("price"):
            car["price_status"] = None
        elif d.get("price_status"):
            car["price_status"] = d["price_status"]
        if d["color"]:
            car["color"] = d["color"]
        if d["interior_color"]:
            car["interior_color"] = d["interior_color"]
        if d["body_type"] and (
            not car.get("body_type") or car["body_type"] == "Other"
        ):
            car["body_type"] = d["body_type"]
        # Mileage gap-fill (2026-10-23): the VDP figure only fills a
        # gap the SRP pass left empty — a real SRP number is the
        # dealer's headline figure and always wins.
        if d.get("mileage") is not None and car.get("mileage") is None:
            car["mileage"] = d["mileage"]

    await asyncio.gather(*(one(c) for c in cars), return_exceptions=True)
    return enriched


# Safety brake for the stale pass: if a single run would deactivate more than
# this fraction of a dealer's active inventory, something is probably wrong
# with the feed itself, so we skip stale marking and log instead.
STALE_MAX_FRACTION = 0.5

# Auto-delete on exit: second belt under the stale brake. Even on a
# healthy crawl, one run never queues more than this many listing
# removals for a user — anything beyond it waits for a later run.
AUTO_DELETE_MAX_PER_RUN = 25


def _auto_delete_on_exit_enabled(uid: str) -> bool:
    """user_settings.auto_delete_on_exit_enabled; default ON.

    Only an explicit False disables auto-delete (the app treats the
    flag the same way). A missing column (the additive migration not
    applied yet) or any read error leaves the feature ON.
    """
    try:
        res = (
            db.table("user_settings")
            .select("auto_delete_on_exit_enabled")
            .eq("user_id", uid)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        if rows and rows[0].get("auto_delete_on_exit_enabled") is False:
            return False
    except Exception as e:
        print(
            f"[*] Auto-delete flag unreadable for user {uid[:8]} ({e}); "
            "defaulting to ON."
        )
    return True


def _queue_exit_listing_removals(uid: str, posted_rows: list) -> int:
    """Queue ONE Facebook delete job per exited car whose listing is
    still live (marketplace_posted_at set).

    Writes the exact contract every other producer writes and the
    extension claims: target_channel "facebook", action "delete",
    status "pending", with year/make/model/stock + price stamped on
    the row so the job stays executable now that the inventory row
    is inactive. DEDUPE: a VIN with a pending/processing delete row
    never gets a second one. Capped at AUTO_DELETE_MAX_PER_RUN.
    Failures are logged and swallowed — queueing removals must never
    break the scrape. Returns the number of rows queued.
    """
    if not posted_rows:
        return 0
    if not _auto_delete_on_exit_enabled(uid):
        print(
            f"[*] Auto-delete on exit is OFF for user {uid[:8]}: "
            f"{len(posted_rows)} exited car(s) keep their live listings."
        )
        return 0
    try:
        existing = (
            db.table("auto_posting_queue")
            .select("vin")
            .eq("user_id", uid)
            .eq("action", "delete")
            .in_("status", ["pending", "processing"])
            .execute()
        ).data or []
        blocked = {r["vin"] for r in existing if r.get("vin")}
    except Exception as e:
        # Without the dedupe read we cannot prove a row is new —
        # skip rather than risk a duplicate delete job.
        print(f"[!] Auto-delete dedupe check failed for user {uid[:8]}: {e}")
        return 0

    rows = []
    skipped_cap = 0
    for r in posted_rows:
        vin = r.get("vin")
        if not vin or vin in blocked:
            continue
        if len(rows) >= AUTO_DELETE_MAX_PER_RUN:
            skipped_cap += 1
            continue
        rows.append(
            {
                "user_id": uid,
                "vin": vin,
                "target_channel": "facebook",
                "action": "delete",
                "status": "pending",
                "year": r.get("year"),
                "make": r.get("make"),
                "model": r.get("model"),
                "stock_num": r.get("stock_number") or r.get("stock_num"),
                "price": r.get("price"),
            }
        )
        blocked.add(vin)
    if skipped_cap:
        print(
            f"[!] Auto-delete cap for user {uid[:8]}: {skipped_cap} exited "
            f"listing(s) NOT queued (max {AUTO_DELETE_MAX_PER_RUN} per run). "
            "They will be queued by a later run."
        )
    if not rows:
        return 0
    try:
        db.table("auto_posting_queue").insert(rows).execute()
    except Exception as e:
        print(f"[!] Auto-delete queue insert failed for user {uid[:8]}: {e}")
        return 0
    print(
        f"[✓] Auto-delete for user {uid[:8]}: queued {len(rows)} listing "
        "removal(s) for exited cars."
    )
    return len(rows)

# =============================================================================
# ==================== AUTO-POST (LOCATION x CONDITION) ======================
# =============================================================================
# Matthew's ask (2026-10-25): the auto poster takes a location x
# condition filter from user_settings and queues EVERY matching car
# that has never been posted — new arrivals and the existing backlog
# alike — paced by the user's daily post limit. Before this pass the
# auto-post switch existed in the app but nothing ever queued cars
# automatically; this pass is the implementation. The guards mirror
# the app's queueing rules exactly: never sold, never no-price,
# never missing a Facebook-required color, and the real-photo count
# must meet the user's minimum-photos choice. Fail-open throughout:
# a failure here must never break the scrape.

def _usable_photo_count(car: dict) -> int:
    """Count REAL photos the way the app does: usable http(s) URLs
    across image_url + photos + custom_photo_urls, deduped, skipping
    /static/ paths and the no-photo fallback asset."""
    urls = set()

    def add(u):
        if not isinstance(u, str):
            return
        u = u.strip()
        if not u:
            return
        if u.startswith("//"):
            u = "https:" + u
        if not (u.startswith("http://") or u.startswith("https://")):
            return
        if "/static/" in u:
            return
        # Normalize for counting: the same photo served at several
        # sizes differs only in the query string (?width=800 vs
        # ?width=1200) and must count ONCE, and a placeholder URL
        # carrying a query string ("no-photo.png?width=...") must
        # still be recognized as the placeholder.
        path = u.split("?", 1)[0].split("#", 1)[0]
        if path.endswith("assets/no-photo.png"):
            return
        urls.add(path)

    add(car.get("image_url"))
    for key in ("photos", "custom_photo_urls"):
        v = car.get(key)
        if isinstance(v, list):
            for u in v:
                add(u)
    return len(urls)


def _condition_matches(condition: str, selected: list) -> bool:
    """Empty selection = every condition. Stored values are 'New',
    'Used', 'Certified Pre-Owned'; matching is by prefix so small
    label drift never silently excludes a whole condition."""
    if not selected:
        return True
    c = (condition or "").strip().lower()
    for s in selected:
        sl = str(s).strip().lower()
        if sl == "new" and c.startswith("new"):
            return True
        if sl == "used" and c.startswith("used"):
            return True
        if sl.startswith("certified") and c.startswith("certified"):
            return True
    return False


def _auto_post_allowed_locations(settings_row: dict):
    """None = all locations. Otherwise the set of RAW location names
    the selected DISPLAY locations cover: a selected location-group
    name expands to its members (the same location_groups mapping
    the app and Luca use); an ungrouped name is its own raw name."""
    selected = settings_row.get("auto_post_locations")
    if not isinstance(selected, list) or not selected:
        return None
    members_by_name = {}
    groups = settings_row.get("location_groups")
    if isinstance(groups, list):
        for g in groups:
            if isinstance(g, dict) and g.get("name"):
                members_by_name[str(g["name"])] = [
                    str(m) for m in (g.get("members") or [])
                ]
    allowed = set()
    for name in selected:
        n = str(name)
        if n in members_by_name:
            allowed.update(members_by_name[n])
        else:
            allowed.add(n)
    return allowed


def _teammate_blocked_vins(uid: str) -> set:
    """DEALERSHIP DUPLICATE GUARD (Matthew, 2026-10-27): the set of
    VINs this user's auto-post pass must not queue because a TEAMMATE
    in the same dealership already has the car on Marketplace, or is
    about to put it there.

    "Live on Marketplace" is the app's own derivation: the
    teammate's inventory row carries marketplace_posted_at — the
    helper stamps it when a post completes and CLEARS it when a
    delete completes, so a car a teammate posted and later took down
    is free again. A teammate's live (pending/processing)
    marketplace queue row blocks too, so two members whose passes
    run in the same window can't both queue the same car.

    Scope: OTHER members of the user's own dealership only, and
    only while the dealership's block_teammate_autopost toggle is
    ON (the default; the leader can turn it off). The user's OWN
    posts and queue rows never enter the set — auto delete & repost
    of one's own listings is untouched, and manual posting never
    comes through this pass at all. Solo users (no membership row)
    return an empty set after a single read, so their pass behaves
    exactly as before. Fail-open throughout, like the rest of this
    pass: any read error logs and returns the empty set — the guard
    must never break or shrink a pass it couldn't check.
    """
    try:
        m = (
            db.table("dealership_account_members")
            .select("dealership_id")
            .eq("user_id", uid)
            .limit(1)
            .execute()
        ).data or []
        if not m:
            return set()
        dealer_id = m[0].get("dealership_id")
        if not dealer_id:
            return set()
        d = (
            db.table("dealership_accounts")
            .select("block_teammate_autopost")
            .eq("id", dealer_id)
            .limit(1)
            .execute()
        ).data or []
        if not d or d[0].get("block_teammate_autopost") is False:
            return set()
        mates = (
            db.table("dealership_account_members")
            .select("user_id")
            .eq("dealership_id", dealer_id)
            .execute()
        ).data or []
        mate_ids = [
            r["user_id"] for r in mates
            if r.get("user_id") and r["user_id"] != uid
        ]
        if not mate_ids:
            return set()
        blocked = set()
        # Teammates' live listings: posted and not since deleted
        # (a completed delete cleared the stamp). Paginated like
        # every wide read in this pass — past 1,000 rows the silent
        # PostgREST cap would hide live cars.
        _off = 0
        while True:
            _page = (
                db.table("scraped_inventory")
                .select("vin, marketplace_posted_at")
                .in_("user_id", mate_ids)
                .order("user_id")
                .order("vin")
                .range(_off, _off + 999)
                .execute()
            ).data or []
            for r in _page:
                if r.get("vin") and r.get("marketplace_posted_at"):
                    blocked.add(r["vin"])
            if len(_page) < 1000:
                break
            _off += 1000
        # Teammates' live marketplace queue rows: the same-window
        # race guard, mirroring the per-user live-job guard above
        # widened to the dealership.
        _off = 0
        while True:
            _page = (
                db.table("auto_posting_queue")
                .select("vin")
                .in_("user_id", mate_ids)
                .eq("target_channel", "marketplace")
                .in_("status", ["pending", "processing"])
                .order("vin")
                .order("id")
                .range(_off, _off + 999)
                .execute()
            ).data or []
            for r in _page:
                if r.get("vin"):
                    blocked.add(r["vin"])
            if len(_page) < 1000:
                break
            _off += 1000
        return blocked
    except Exception as e:
        print(
            f"[!] Dealership duplicate guard read failed for user "
            f"{uid[:8]} (non-fatal; guard off for this pass): {e}"
        )
        return set()


def _auto_post_filtered(uid: str) -> int:
    """Queue post jobs for every unposted car matching the user's
    location x condition filter, up to today's remaining daily
    allowance. Returns the number of CARS queued. Never raises."""
    try:
        res = (
            db.table("user_settings")
            .select("auto_post_enabled, auto_post_min_photos, auto_post_locations, auto_post_conditions, location_groups, daily_post_limit, channel_instagram_enabled, channel_tiktok_enabled, channel_facebook_page_enabled")
            .eq("user_id", uid)
            .limit(1)
            .execute()
        )
        rows = res.data or []
        if not rows:
            return 0
        s = rows[0]
        if s.get("auto_post_enabled") is not True:
            return 0
        try:
            min_photos = max(1, int(s.get("auto_post_min_photos") or 1))
        except Exception:
            min_photos = 1
        conditions = s.get("auto_post_conditions")
        if not isinstance(conditions, list):
            conditions = []
        allowed_locations = _auto_post_allowed_locations(s)
        # Compare locations case/whitespace-insensitively on BOTH sides:
        # a stored display name or a scraped lot name drifting by a
        # trailing space or capital would otherwise fail the whole
        # filter closed, silently, for every car at that lot.
        allowed_norm = None
        if allowed_locations is not None:
            allowed_norm = {str(n).strip().lower() for n in allowed_locations}
        try:
            limit = int(s.get("daily_post_limit"))
        except Exception:
            limit = 10
        unlimited = limit >= 999

        # Today's usage, mirroring the app's getDailyPostUsage: today's
        # marketplace queue rows that did not fail, plus cars posted
        # today that are not already counted. (UTC day boundary; the
        # app/extension count from local midnight — a pacing cap does
        # not need to agree to the minute.)
        start_iso = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        ).isoformat()
        used = 0
        counted_vins = set()
        q = (
            db.table("auto_posting_queue")
            .select("vin, status")
            .eq("user_id", uid)
            .eq("target_channel", "marketplace")
            .gte("created_at", start_iso)
            .execute()
        ).data or []
        for r in q:
            if r.get("status") != "failed":
                used += 1
                if r.get("vin"):
                    counted_vins.add(r["vin"])
        p = (
            db.table("scraped_inventory")
            .select("vin")
            .eq("user_id", uid)
            .gte("marketplace_posted_at", start_iso)
            .execute()
        ).data or []
        for r in p:
            if r.get("vin") and r["vin"] not in counted_vins:
                used += 1
        allowance = None if unlimited else max(0, limit - used)
        if allowance is not None and allowance <= 0:
            print(f"[*] Auto-post for user {uid[:8]}: daily limit already reached ({used}/{limit}).")
            return 0

        # A VIN already holding a live post job never gets a second.
        # Paginated like the candidate scan below: past 1,000 live
        # rows the silent PostgREST cap would hide older live jobs
        # and the pass could double-queue their cars.
        live = []
        _loff = 0
        while True:
            _lpage = (
                db.table("auto_posting_queue")
                .select("vin, target_channel")
                .eq("user_id", uid)
                .in_("status", ["pending", "processing"])
                .order("vin")
                .order("target_channel")
                .range(_loff, _loff + 999)
                .execute()
            ).data or []
            live.extend(_lpage)
            if len(_lpage) < 1000:
                break
            _loff += 1000
        live_keys = {
            (r.get("vin"), r.get("target_channel") or "marketplace")
            for r in live if r.get("vin")
        }

        # NOTE (2026-10-25, post-mortem): the first two live runs of
        # this pass queued NOTHING while 60 cars matched every filter.
        # Root cause: PostgREST silently caps a response at 1,000
        # rows, so a single .limit(4000) query only ever saw the
        # NEWEST 1,000 unposted cars — and every qualifying car is
        # older backlog beyond that window (verified: 0 of the 60
        # matches fall inside it). The pass therefore PAGINATES with
        # .range() — the same pattern the stale pass uses — until a
        # short page comes back, and orders by vin as a tiebreaker so
        # pages can't shuffle tied first_seen rows across boundaries.
        inv = []
        _page_size = 1000
        _offset = 0
        while True:
            _page = (
                db.table("scraped_inventory")
                .select("vin, year, make, model, price, condition, color, interior_color, status, location_name, stock_number, image_url, photos, custom_photo_urls, first_seen")
                .eq("user_id", uid)
                .eq("is_active", True)
                .is_("marketplace_posted_at", "null")
                .order("first_seen", desc=True)
                .order("vin")
                .range(_offset, _offset + _page_size - 1)
                .execute()
            ).data or []
            inv.extend(_page)
            if len(_page) < _page_size:
                break
            _offset += _page_size
        print(
            f"[*] Auto-post for user {uid[:8]}: filter locations="
            f"{'all' if allowed_locations is None else sorted(allowed_locations)}, "
            f"conditions={conditions or 'all'}, photos>={min_photos}, "
            f"allowance={allowance if allowance is not None else 'unlimited'}, "
            f"unposted active cars in inventory={len(inv)}."
        )

        # DEALERSHIP DUPLICATE GUARD: VINs a teammate already posted
        # (or is about to post) are off-limits to this pass while the
        # dealership's guard is on. Computed once, at pass time, so a
        # leader's toggle flip applies to the very next run. Solo
        # users get an empty set — see _teammate_blocked_vins.
        blocked_vins = _teammate_blocked_vins(uid) if inv else set()
        guard_skipped = 0

        channels = ["marketplace"]
        if s.get("channel_instagram_enabled") is True:
            channels.append("instagram")
        if s.get("channel_tiktok_enabled") is True:
            channels.append("tiktok")
        if s.get("channel_facebook_page_enabled") is True:
            channels.append("facebook_page")

        def _missing_color(v):
            t = str(v or "").strip().lower()
            return not t or t == "standard"

        queue_rows = []
        cars_queued = 0
        for car in inv:
            if allowance is not None and cars_queued >= allowance:
                break
            if (car.get("status") or "").strip().lower() == "sold":
                continue
            if allowed_norm is not None and (car.get("location_name") or "").strip().lower() not in allowed_norm:
                continue
            if not _condition_matches(car.get("condition") or "", conditions):
                continue
            try:
                price_ok = bool(car.get("price")) and float(car["price"]) > 0
            except Exception:
                price_ok = False
            if not price_ok:
                continue
            if _missing_color(car.get("color")) or _missing_color(car.get("interior_color")):
                continue
            if _usable_photo_count(car) < min_photos:
                continue
            vin = car.get("vin")
            if not vin:
                continue
            if vin in blocked_vins:
                guard_skipped += 1
                continue
            new_rows = []
            for ch in channels:
                if (vin, ch) in live_keys:
                    continue
                new_rows.append({
                    "user_id": uid,
                    "vin": vin,
                    "target_channel": ch,
                    "status": "pending",
                    "year": car.get("year"),
                    "make": car.get("make"),
                    "model": car.get("model"),
                    "stock_num": car.get("stock_number"),
                    "price": car.get("price"),
                })
                live_keys.add((vin, ch))
            if new_rows:
                queue_rows.extend(new_rows)
                cars_queued += 1
        if guard_skipped:
            print(
                f"[*] Auto-post for user {uid[:8]}: dealership guard "
                f"skipped {guard_skipped} car(s) a teammate already "
                f"posted or has queued."
            )
        if not queue_rows:
            print(f"[*] Auto-post for user {uid[:8]}: no unposted cars match the filter right now.")
            return 0
        # Insert in chunks: one giant all-or-nothing request for an
        # unlimited user could fail on payload size and queue nothing
        # at all. A failed chunk still surfaces via the outer warning;
        # chunks already inserted are protected from re-queueing next
        # run by the live-job guard above.
        for _ci in range(0, len(queue_rows), 200):
            db.table("auto_posting_queue").insert(queue_rows[_ci:_ci + 200]).execute()
        print(
            f"[✓] Auto-post for user {uid[:8]}: queued {cars_queued} car(s) "
            f"across {len(channels)} channel(s) "
            f"(locations={'all' if allowed_locations is None else len(allowed_locations)}, "
            f"conditions={conditions or 'all'}, photos>={min_photos}, "
            f"used today {used}/{'unlimited' if unlimited else limit})."
        )
        return cars_queued
    except Exception as e:
        print(f"[!] Auto-post pass warning for user {uid[:8]} (non-fatal): {e}")
        return 0


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
        active_rows = []
        page_size = 1000
        offset = 0
        while True:
            res = (
                db.table("scraped_inventory")
                .select("vin, marketplace_posted_at, year, make, model, price, stock_number")
                .eq("user_id", uid)
                .eq("is_active", True)
                .order("vin")
                .range(offset, offset + page_size - 1)
                .execute()
            )
            rows = res.data or []
            active_rows.extend(r for r in rows if r.get("vin"))
            if len(rows) < page_size:
                break
            offset += page_size

        active_vins = [r["vin"] for r in active_rows]
        stale = [v for v in active_vins if v not in seen_vins]
        if not stale:
            return 0

        # MASS-EXIT SAFETY BRAKE: past the threshold we mark NOTHING
        # and queue NOTHING — a broken feed must never mass-delete
        # live listings.
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

        # Auto-delete on exit: the cars that just left AND still have
        # a live listing get one delete job each (deduped + capped
        # inside the helper).
        stale_set = set(stale)
        posted_exits = [
            r for r in active_rows
            if r["vin"] in stale_set and r.get("marketplace_posted_at")
        ]
        if posted_exits:
            _queue_exit_listing_removals(uid, posted_exits)
        return flagged
    except Exception as e:
        print(f"[!] Stale pass warning (non-fatal): {e}")
        return 0
# ==============================================================================
# ====================== SYNC CADENCE GUARD START ==============================
# ==============================================================================
# Per-plan inventory sync cadence (Matthew, 2026-10-26): ONE
# user-requested sync per window — trial 24h, Post 18h, Automate 12h,
# Group 6h (any Group account; dealership-covered members resolve to
# their dealership's FLAVOR cadence — Group flavor and dealership
# trials at 6h, Post flavor at 18h, mirroring the app). The app gates
# the Sync button with the same numbers (SYNC_COOLDOWN_HOURS in
# index.html — keep the two maps in step); this guard is the backstop
# for scrape_jobs rows inserted any other way. It applies ONLY to
# user-requested jobs: a run serving a pending non-test job. Scheduled
# runs carry no job row and are never guarded, and 'test' jobs (the
# onboarding preview) are never blocked and never set the clock — the
# initial scrape when opening a new account never counts. Owners are
# exempt (mirrors OWNER_USER_IDS in the app). Fail-open throughout: a
# missing settings row, an unreadable timestamp, or any lookup error
# lets the crawl proceed; the guard bites only when a settings row
# clearly resolves a tier and the window clearly has not elapsed.
SYNC_COOLDOWN_HOURS = {"trial": 24, "post": 18, "automate": 12, "group": 6}
OWNER_USER_IDS = {
    "40a95557-504a-460f-a891-462bb2b4f25c",  # Matthew
    "9cdba37e-ac31-464d-92b9-0745772fbf00",  # Jourdan
}


def _resolve_tier_scraper(raw):
    # Mirror of the app's resolveTier(): real tiers pass through, no
    # value means a brand-new 'post', and any legacy value ('trial',
    # 'free', ...) resolves to 'automate' so nobody loses access.
    if raw in ("post", "automate", "group"):
        return raw
    if raw is None or raw == "":
        return "post"
    return "automate"


def _parse_job_ts(value):
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _sync_cooldown_hours(uid, settings_row, covered):
    """Sync window in hours for this account, or None = no cadence.
    `covered` is the dealership coverage tier from
    _dealership_covered() ('post'/'group') or None."""
    if uid in OWNER_USER_IDS:
        return None
    if covered:
        return SYNC_COOLDOWN_HOURS.get(covered, SYNC_COOLDOWN_HOURS["group"])
    if not settings_row:
        return None  # fail-open: nothing on file to resolve against
    if settings_row.get("billing_status") == "trialing":
        return SYNC_COOLDOWN_HOURS["trial"]
    return SYNC_COOLDOWN_HOURS[_resolve_tier_scraper(settings_row.get("plan_tier"))]


def _sync_cadence_block_reason(uid, job, settings_row, covered, prior_jobs, now):
    """Reason string if this job must be cadence-refused, else None.
    Pure: prior_jobs is the account's scrape_jobs history; the current
    job (matched by id) and every 'test' row are excluded from the
    clock — the clock is the most recent prior NON-TEST job."""
    if not job:
        return None
    if job.get("sync_mode") == "test":
        return None
    hours = _sync_cooldown_hours(uid, settings_row, covered)
    if hours is None:
        return None
    priors = [
        j for j in (prior_jobs or [])
        if j.get("id") != job.get("id") and j.get("sync_mode") != "test"
    ]
    if not priors:
        return None  # first real sync — the initial scrape never counts
    latest = max(priors, key=lambda j: j.get("started_at") or "")
    started = _parse_job_ts(latest.get("started_at"))
    if started is None:
        return None  # fail-open on an unreadable clock
    unlock = started + timedelta(hours=hours)
    if now < unlock:
        return (
            f"last non-test sync started {latest.get('started_at')} is inside "
            f"this plan's {hours}h sync window (next sync at {unlock.isoformat()})"
        )
    return None


def _dealership_covered(uid):
    """Best-effort: the coverage TIER ('post'/'group') when this user
    is a covered dealership MEMBER, else None (Phase 2). Coverage
    mirrors the app exactly: an ACTIVE dealership covers at its
    bought flavor (no flavor on file -> 'group'); a dealership still
    inside its 5-day trial window covers at 'group'; anything else
    covers nobody. The dealership LEADER (role 'admin') is NEVER
    covered — that account is manage-only (Matthew, 2026-10-26), so
    only role 'member' rows count. Any read problem answers None and
    the normal billing resolution decides instead."""
    try:
        rows = (
            db.table("dealership_account_members")
            .select("dealership_id, role")
            .eq("user_id", uid)
            .execute()
        ).data or []
        for r in rows:
            if r.get("role") != "member":
                continue
            d = (
                db.table("dealership_accounts")
                .select("status, plan_flavor, trial_ends_at")
                .eq("id", r.get("dealership_id"))
                .execute()
            ).data or []
            if not d:
                continue
            status = d[0].get("status")
            if status == "active":
                return d[0].get("plan_flavor") or "group"
            if status == "trial":
                ends = _parse_job_ts(d[0].get("trial_ends_at"))
                if ends is not None and datetime.now(timezone.utc) < ends:
                    return "group"
    except Exception:
        pass
    return None


def _apply_sync_cadence_guard(uid, job, settings_row):
    """Backstop enforcement for one user-requested job. Returns True
    when the job was refused: it is marked failed (cars_synced 0) and
    the caller must skip the crawl."""
    if job.get("sync_mode") == "test":
        return False
    covered = _dealership_covered(uid)
    priors = (
        db.table("scrape_jobs")
        .select("id, started_at, sync_mode")
        .eq("user_id", uid)
        .execute()
    ).data or []
    reason = _sync_cadence_block_reason(
        uid, job, settings_row, covered, priors, datetime.now(timezone.utc)
    )
    if not reason:
        return False
    db.table("scrape_jobs").update({
        "status": "failed",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "cars_synced": 0,
    }).eq("id", job["id"]).execute()
    print(f"[!] Sync cadence: job {job['id']} refused for user {uid[:8]} — {reason}")
    return True
# ==============================================================================
# ====================== SYNC CADENCE GUARD END ================================
# ==============================================================================

# ==============================================================================
# ====================== SCRAPER ENTRYPOINT START ==============================
# ==============================================================================

async def run_scraper():

    active_job_id = None
    active_job_mode = None
    active_job = None
    target_settings_row = None

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
            active_job_mode = latest_job.get("sync_mode")
            active_job = latest_job

        print(
            f"ACTIVE_JOB_ID => {active_job_id}"
        )

        res = (
            db.table("user_settings")
            .select("*")
            .eq("user_id", target_uid.strip())
            .execute()
        )

        target_settings_row = (res.data or [None])[0]

        users_to_scrape = res.data or []

    else:

        res = (
            db.table("user_settings")
            .select("*")
            .execute()
        )

        users_to_scrape = res.data or []

    # SYNC CADENCE GUARD (Matthew, 2026-10-26): refuse a user-requested
    # job that lands inside the account's sync window. active_job is
    # set only when this run serves a pending job for USER_ID, so
    # scheduled runs (no job) walk straight past. Fail-open: any guard
    # error is logged and the crawl proceeds.
    if active_job is not None:
        try:
            if _apply_sync_cadence_guard(
                (target_uid or "").strip(), active_job, target_settings_row
            ):
                return
        except Exception as e:
            print(f"[!] Sync cadence guard warning (non-fatal, proceeding): {e}")

    if not users_to_scrape:

        print(
            "[-] No user accounts with configured dealership settings found."
        )

        return

    print(
        f"[*] Found {len(users_to_scrape)} account(s) registered in database."
    )

    total_synced_all = 0
    auto_post_uids = set()

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

            # Effective cap for THIS user (see TEST_SYNC_LIMIT note): the
            # pending job's sync_mode wins over the env when this run is
            # serving that job; otherwise the env input rules.
            effective_limit = SCRAPE_LIMIT
            if active_job_mode and active_uid == (target_uid or "").strip():
                if active_job_mode == "test":
                    effective_limit = TEST_SYNC_LIMIT
                elif active_job_mode == "full":
                    effective_limit = 0
                print(
                    f"[*] Sync mode for this user: {active_job_mode} -> cap "
                    f"{effective_limit if effective_limit else 'none (full pull)'}"
                )

            for feed in feeds_to_crawl:

                if effective_limit and user_units_synced >= effective_limit:

                    print(
                        f"[*] SCRAPE_LIMIT of {effective_limit} reached. Skipping remaining feeds for this user."
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

                    if effective_limit:

                        remaining = effective_limit - user_units_synced

                        if remaining <= 0:

                            print(
                                f"[*] SCRAPE_LIMIT of {effective_limit} reached for this user. Stopping test crawl."
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

                    # VDP enrichment: full photo gallery + advertised final
                    # price + spec colors from each car's detail page.
                    enriched = await enrich_cars_with_vdp(context, cars)

                    if enriched:

                        print(
                            f"[++] VDP enrichment: {enriched}/{len(cars)} cars got full photo galleries"
                        )

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
            if effective_limit:

                print(
                    f"[!] Stale pass skipped for {store_name}: capped test run (SCRAPE_LIMIT={effective_limit}) never deactivates inventory."
                )

            elif user_seen_vins and not user_had_error:

                mark_stale_inventory(active_uid, user_seen_vins)

                # A clean, full crawl also earns the auto-post pass
                # (it runs once per user after the crawl loop).
                if active_uid:
                    auto_post_uids.add(active_uid)

            elif user_seen_vins and user_had_error:

                print(
                    f"[!] Stale pass skipped for {store_name}: crawl had errors."
                )

            print(
                f"[✓] Completed crawl for {store_name}: {user_units_synced} units synced."
            )

        # Auto-post pass (location x condition filter): once per user
        # whose crawl was clean and complete. Fail-open inside.
        for _uid in auto_post_uids:
            _auto_post_filtered(_uid)

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
