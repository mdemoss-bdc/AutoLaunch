#!/usr/bin/env python3
"""
generator.py — AutoLaunch VIN Reels generator (rebuild).

Renders ONE per-VIN showcase reel end to end:

  inventory row -> photo sequence (slow push-in, plain crossfades, navy
  end card — the approved spike design) -> facts-only voiceover script
  (stored fields + NHTSA VIN decode for engine/drivetrain ONLY) -> Helio
  TTS -> canonical audio mix -> finished-file size gate + QA gate -> upload to the
  public `vin-reels` bucket at <user_id>/<vin>.mp4 -> vin_reels row
  finished (ready + video_url + qa, or failed + error + qa).

THE AUDIO LESSON (paid for with a failed delivery on 2026-11-05): the
mix is built EXACTLY like the hand-remix Matt approved — ducked bed stem
+ voice stem summed at NATIVE gains (amix normalize=0), then ONE uniform
makeup gain so the mix peaks at -1.5 dB. NO loudnorm, NO dynamics on the
sum: a loudnorm pass on the sum raised the bed ~14 dB and buried the
voice ~10 dB under the music. And QA measures the FINISHED FILE, never
the stems (see qa_gate).

Usage:
    python3 generator.py --row-id <vin_reels uuid>
    python3 generator.py --user-id <uuid> --stock <stock_number>
    python3 generator.py --user-id <uuid> --vin <vin>

Exit code 0 = reel ready (or row was already finished); 1 = reel failed
(the row carries the error). Unexpected crashes also mark the row failed
when a row is known.
"""
import argparse, json, math, os, re, subprocess, sys, tempfile, time
import urllib.request, urllib.error
from datetime import datetime, timezone

def _now_iso():
    return datetime.now(timezone.utc).isoformat()

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SUPABASE_API = os.path.expanduser(
    "~/workspace/custom-connectors/custom.supabase/bin/supabase_api.py")
PROJECT_REF = "tdsipiltwajwhzgjsupx"
SUPABASE_URL = f"https://{PROJECT_REF}.supabase.co"
BUCKET = "vin-reels"
VOICE_ID = "avocado_v2:MAI_03"  # Helio — the approved default voice
TTS_BIN = "/opt/hatch/bin/tts"
MUSIC_BED = os.path.join(HERE, "assets", "music-bed.mp3")
PHOTO_CACHE = os.path.expanduser("~/.cache/vinreels/photos")

# Frame size (Matthew, 2026-11-06): 720x1280, NOT the spike's
# 1080x1920. Proven at the desk that day: 1080p reels land at
# 20.7-22.7 MB and Facebook's vehicle composer will not ingest them
# (they fail via the helper AND via a hand upload — the Videos
# counter never registers), while the identical reel re-encoded to
# 720p / 3.8 MB attached instantly. Every absolute pixel value in
# the design below stays a 1080p-design number, scaled at use by
# _px(), so the approved composition is unchanged — only the
# raster is smaller.
W, H, FPS = 720, 1280, 30

def _px(v):
    """Scale a 1080p-design pixel value to the render width."""
    return int(round(v * W / 1080))

VIDEO_CRF = 28          # final video encode (the proven 720p recipe:
                        # a ~36s reel lands ~3.5-6 MB, not ~21 MB)
SIZE_LIMIT_BYTES = 8 * 1024 * 1024   # hard finished-file gate: an
                        # oversized reel is one Facebook silently
                        # drops, so the generator must never upload
                        # one (see enforce_size_gate)
SIZE_RETRY_CRF = VIDEO_CRF + 4       # the gate's one stronger retry
NAVY = (10, 23, 48)
BLUE = (86, 166, 255)
WHITE = (255, 255, 255)
ZOOM = 1.06            # total push-in across one shot
SHARPEN = 40           # gentle unsharp % after upscale
XFADE = 0.45           # crossfade seconds
TITLE_DUR = 3.3
SHOT_DUR = 2.75
CARD_DUR = 2.6
MAX_PHOTOS = 12
MIN_PHOTOS = 4
PEAK_TARGET_DB = -1.5  # the approved mix peaks here

# ================================================================ services
def sql_query(sql):
    """Read/write via the Management API helper (Matthew's standing
    access). Returns parsed JSON (list of rows for SELECT/RETURNING)."""
    out = subprocess.run([sys.executable, SUPABASE_API, "query",
                          "--sql", sql],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else []

def _sql_str(v):
    return "'" + str(v).replace("'", "''") + "'"

_service_key = None
def service_key():
    """Fetch the project service_role key through the connector
    surrogate (the auth_admin.py pattern). In memory only — never
    printed, never written to disk."""
    global _service_key
    if _service_key:
        return _service_key
    sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
    from dynamic_credentials import add_surrogate_to_request, \
        read_json_response
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{PROJECT_REF}/api-keys",
        headers={"User-Agent": "AutoLaunch-VinReels-Worker"})
    add_surrogate_to_request(req, "custom.supabase",
                             allowed_hosts=["api.supabase.com"])
    with urllib.request.urlopen(req, timeout=60) as resp:
        keys = read_json_response(resp)
    for k in keys:
        if k.get("name") == "service_role":
            _service_key = k["api_key"]
            return _service_key
    raise RuntimeError("service_role key not found")

def rest(method, path, body=None, headers=None, raw=None):
    key = service_key()
    h = {"apikey": key, "Authorization": "Bearer " + key}
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    if headers:
        h.update(headers)
    req = urllib.request.Request(SUPABASE_URL + path, data=data,
                                 headers=h, method=method)
    # Transport retry (added 2026-11-05 desk test): the VM egress drops
    # connections intermittently (RemoteDisconnected / IncompleteRead);
    # retry transport failures only — an HTTPError is a real response
    # and returns exactly as before.
    import http.client as _hc
    last_exc = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                txt = resp.read().decode()
                return resp.status, (json.loads(txt) if txt.strip() else None)
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(txt)
            except Exception:
                parsed = {"message": txt[:300]}
            return e.code, parsed
        except (urllib.error.URLError, ConnectionError, TimeoutError,
                _hc.HTTPException) as e:
            last_exc = e
            if attempt < 4:
                time.sleep(2 ** attempt)
    raise last_exc

def row_get(row_id):
    rows = sql_query("SELECT id, user_id, vin, stock_number, status, "
                     "video_url FROM public.vin_reels WHERE id="
                     + _sql_str(row_id))
    return rows[0] if rows else None

def row_insert(user_id, vin, stock_number):
    status, body = rest("POST", "/rest/v1/vin_reels",
                        body={"user_id": user_id, "vin": vin,
                              "stock_number": stock_number,
                              "status": "queued"},
                        headers={"Prefer": "return=representation"})
    if status in (200, 201) and body:
        return body[0]
    # 409 = a live (queued/generating) row already exists for this VIN:
    # adopt it instead of failing.
    rows = sql_query(
        "SELECT id, user_id, vin, stock_number, status, video_url "
        "FROM public.vin_reels WHERE user_id=" + _sql_str(user_id)
        + " AND vin=" + _sql_str(vin)
        + " AND status IN ('queued','generating') "
          "ORDER BY created_at LIMIT 1")
    if rows:
        return rows[0]
    raise RuntimeError(f"vin_reels insert failed: {status} {body}")

def row_claim(row_id):
    """queued -> generating (conditional: a no-op if already claimed)."""
    rest("PATCH", f"/rest/v1/vin_reels?id=eq.{row_id}&status=eq.queued",
         body={"status": "generating", "updated_at": _now_iso()},
         headers={"Prefer": "return=minimal"})

def row_finish(row_id, status, video_url=None, error=None, qa=None):
    body = {"status": status, "updated_at": _now_iso()}
    if video_url is not None:
        body["video_url"] = video_url
    if error is not None:
        body["error"] = str(error)[:800]
    if qa is not None:
        body["qa"] = qa
    st, resp = rest("PATCH", f"/rest/v1/vin_reels?id=eq.{row_id}",
                    body=body, headers={"Prefer": "return=minimal"})
    if st >= 300:
        raise RuntimeError(f"row_finish failed: {st} {resp}")

def storage_upload(user_id, vin, mp4_path):
    """Upload to the deterministic object path <user_id>/<vin>.mp4
    (upsert) so video_url is stable across re-renders, and return the
    public URL."""
    obj = f"{user_id}/{vin}.mp4"
    with open(mp4_path, "rb") as fh:
        data = fh.read()
    st, resp = rest("POST", f"/storage/v1/object/{BUCKET}/{obj}",
                    raw=data,
                    headers={"Content-Type": "video/mp4",
                             "x-upsert": "true",
                             "cache-control": "public, max-age=3600"})
    if st >= 300:
        raise RuntimeError(f"storage upload failed: {st} {resp}")
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{obj}"

# ================================================================ car data
def fetch_car(user_id, vin=None, stock=None):
    where = f"user_id={_sql_str(user_id)}"
    if vin:
        where += f" AND vin={_sql_str(vin)}"
    elif stock:
        where += f" AND stock_number={_sql_str(stock)}"
    else:
        raise ValueError("vin or stock required")
    rows = sql_query(
        "SELECT stock_number, vin, year, make, model, price, mileage, "
        "color, interior_color, image_url, photos, custom_photo_urls "
        f"FROM public.scraped_inventory WHERE {where} "
        "ORDER BY is_active DESC LIMIT 1")
    if not rows:
        raise RuntimeError("no inventory row for this car")
    return rows[0]

def fetch_dealership(user_id):
    rows = sql_query(
        "SELECT dealership_name, store_name FROM public.user_settings "
        f"WHERE user_id={_sql_str(user_id)}")
    if rows:
        return (rows[0].get("dealership_name")
                or rows[0].get("store_name") or "").strip()
    return ""

def fetch_contact(user_id):
    """The rep contact line for the end card (Matthew, 2026-11-06):
    'Call or text {rep_display_name} · {rep_phone}' — returned only
    when BOTH settings are present; either missing -> no line at all
    (the dealership-name rule). Text only: build_script never reads
    this, so the number is never spoken."""
    rows = sql_query(
        "SELECT rep_display_name, rep_phone FROM public.user_settings "
        f"WHERE user_id={_sql_str(user_id)}")
    if rows:
        name = (rows[0].get("rep_display_name") or "").strip()
        phone = (rows[0].get("rep_phone") or "").strip()
        if name and phone:
            return f"Call or text {name} · {phone}"
    return ""

def photo_list(car):
    """Mirror the app's vehiclePhotoList: cover first, then gallery,
    then user-added photos; dedupe by path; skip placeholders."""
    seen, out = set(), []
    def add(u):
        if not isinstance(u, str):
            return
        u = u.strip()
        if u.startswith("//"):
            u = "https:" + u
        if not u.startswith(("http://", "https://")):
            return
        if "/static/" in u:
            return
        path = u.split("?")[0].split("#")[0]
        if path.endswith("assets/no-photo.png") or path in seen:
            return
        seen.add(path)
        out.append(u)
    add(car.get("image_url"))
    for k in ("photos", "custom_photo_urls"):
        v = car.get(k)
        if isinstance(v, list):
            for u in v:
                add(u)
    return out

def download_photos(car, urls):
    d = os.path.join(PHOTO_CACHE, car["user_key"], car["stock_number"])
    os.makedirs(d, exist_ok=True)
    paths = []
    for i, url in enumerate(urls):
        p = os.path.join(d, f"{i:02d}.jpg")
        if not os.path.exists(p):
            req = urllib.request.Request(
                url, headers={"User-Agent": "Mozilla/5.0"})
            last_exc = None
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(req, timeout=40) as r, \
                            open(p, "wb") as fh:
                        fh.write(r.read())
                    last_exc = None
                    break
                except Exception as e:
                    last_exc = e
                    if attempt < 2:
                        time.sleep(2)
            if last_exc is not None:
                raise last_exc
        paths.append(p)
    return paths

def fmt_price(n):
    return "$" + f"{int(n):,}"

def fmt_miles(n):
    return f"{int(n):,} miles"

# ================================================================ fonts
def _font(path, size, weight=None, axes=None):
    f = ImageFont.truetype(path, size)
    if weight is not None and axes:
        try:
            f.set_variation_by_axes([axes[0], weight] if len(axes) > 1
                                    else [weight])
        except Exception:
            pass
    return f

def font(name, size, weight=400):
    """name: 'inter' | 'mont'. Vendored variable fonts; Liberation
    Sans fallback."""
    paths = {
        "inter": (os.path.join(HERE, "fonts", "Inter.ttf"), [14, weight]),
        "mont": (os.path.join(HERE, "fonts", "Montserrat.ttf"), [weight]),
    }
    p, axes = paths[name]
    if os.path.exists(p):
        return _font(p, size, weight, axes)
    fb = "/usr/share/fonts/truetype/liberation/LiberationSans-%s.ttf" % (
        "Bold" if weight >= 600 else "Regular")
    return ImageFont.truetype(fb, size)

def text_w(draw, s, fnt, tracking=0):
    tracking = _px(tracking)  # callers pass 1080p-design units
    if not s:
        return 0
    w = sum(draw.textlength(ch, font=fnt) for ch in s)
    return w + tracking * (len(s) - 1)

def draw_tracked(draw, xy, s, fnt, fill, tracking=0):
    tracking = _px(tracking)  # callers pass 1080p-design units
    x, y = xy
    for ch in s:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + tracking
    return x - tracking

def fit_font(draw, name, s, start, max_w, weight=400, tracking=0, floor=24):
    # start/floor arrive in 1080p-design units; render sizes scale.
    size = _px(start)
    floor = _px(floor)
    while size > floor:
        f = font(name, size, weight)
        if text_w(draw, s, f, tracking) <= max_w:
            return f, size
        size -= 1
    return font(name, floor, weight), floor

# ================================================================ overlays
def make_scrim(strength=185):
    y = np.linspace(0, 1, H, dtype=np.float32)
    a = np.clip((y - 0.50) / 0.50, 0, 1) ** 1.4 * strength
    alpha = np.repeat(a[:, None], W, axis=1).astype(np.uint8)
    img = np.zeros((H, W, 4), dtype=np.uint8)
    img[..., 3] = alpha
    return Image.fromarray(img, "RGBA")

def _layer():
    return Image.new("RGBA", (W, H), (0, 0, 0, 0))

def _car_name(car):
    return f"{car['year']} {car['make']} {car['model']}"

def make_title_overlay(car):
    img = _layer()
    d = ImageDraw.Draw(img)
    margin, max_w = _px(64), W - 2 * _px(64)
    name = _car_name(car)
    dealer = (car.get("_dealership") or "").upper()
    parts = []
    if car.get("color"):
        parts.append(str(car["color"]))
    if car.get("mileage"):
        parts.append(fmt_miles(car["mileage"]))
    sub = " • ".join(parts)
    sub_f, _ = fit_font(d, "inter", sub, 36, max_w, weight=400, floor=26)
    sub_h = sub_f.size
    y_sub = H - _px(118) - sub_h
    title_f, _ = fit_font(d, "mont", name, 86, max_w, weight=700, floor=40)
    y_title = y_sub - _px(26) - title_f.size
    if dealer:
        eb_f = font("mont", _px(29), 600)
        y_eb = y_title - _px(30) - eb_f.size
        y_rule = y_eb - _px(24)
        d.rectangle([margin, y_rule, margin + _px(64), y_rule + _px(4)],
                    fill=BLUE + (255,))
        draw_tracked(d, (margin, y_eb), dealer, eb_f, BLUE + (255,),
                     tracking=10)
    d.text((margin, y_title), name, font=title_f, fill=WHITE + (255,))
    if sub:
        d.text((margin, y_sub), sub, font=sub_f, fill=WHITE + (242,))
    return img

def make_lowerthird_overlay(car):
    img = _layer()
    d = ImageDraw.Draw(img)
    margin = _px(64)
    name = _car_name(car)
    nf = font("mont", _px(31), 600)
    y = H - _px(96) - nf.size
    d.text((margin, y), name, font=nf, fill=WHITE + (235,))
    if car.get("price"):
        price = fmt_price(car["price"])
        pf = font("inter", _px(31), 600)
        pw = d.textlength(price, font=pf)
        d.text((W - margin - pw, y), price, font=pf, fill=WHITE + (235,))
    return img

def make_end_card(car):
    img = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(img)
    cx = W // 2
    name = _car_name(car)
    dealer = (car.get("_dealership") or "").upper()
    y = int(H * 0.40)
    if dealer:
        eb_f = font("mont", _px(27), 600)
        eb_w = text_w(d, dealer, eb_f, tracking=10)
        draw_tracked(d, (cx - eb_w / 2, y), dealer, eb_f, BLUE + (255,),
                     tracking=10)
        y += _px(27) + _px(26)
        d.rectangle([cx - _px(28), y, cx + _px(28), y + _px(4)], fill=BLUE)
        y += _px(44)
    if car.get("price"):
        price = fmt_price(car["price"])
        price_f, _ = fit_font(d, "mont", price, 132, W - _px(160),
                              weight=800, floor=60)
        pw = d.textlength(price, font=price_f)
        d.text((cx - pw / 2, y), price, font=price_f, fill=WHITE)
        y += price_f.size + _px(30)
    name_f = font("inter", _px(38), 500)
    nw = d.textlength(name, font=name_f)
    d.text((cx - nw / 2, y), name, font=name_f, fill=(255, 255, 255))
    y += name_f.size
    if car.get("mileage"):
        y += _px(12)
        miles_f = font("inter", _px(32), 400)
        mw = d.textlength(fmt_miles(car["mileage"]), font=miles_f)
        d.text((cx - mw / 2, y), fmt_miles(car["mileage"]), font=miles_f,
               fill=(198, 212, 232))
        y += miles_f.size
    contact = (car.get("_contact") or "").strip()
    if contact:
        # Rep contact line (Matthew, 2026-11-06): under the name/miles
        # block, above the fixed 0 TO POSTED foot. The block bottom
        # stays hundreds of px above the foot — nothing else moves.
        y += _px(30)
        c_f, _ = fit_font(d, "inter", contact, 36, W - _px(120),
                          weight=600, floor=24)
        cw = d.textlength(contact, font=c_f)
        d.text((cx - cw / 2, y), contact, font=c_f, fill=WHITE)
    tag = "0 TO POSTED"
    tag_f = font("mont", _px(25), 600)
    tag_w = text_w(d, tag, tag_f, tracking=8)
    draw_tracked(d, (cx - tag_w / 2, H - _px(150)), tag, tag_f,
                 BLUE + (255,), tracking=8)
    return img

# ================================================================ shots
class Shot:
    def __init__(self, path, anchor_x=0.5):
        im = Image.open(path)
        im = ImageOps.exif_transpose(im).convert("RGB")
        self.im = im
        sw, sh = im.size
        target = W / H
        if sw / sh > target:      # landscape: full height, crop width
            bh = float(sh); bw = bh * target
        else:                     # portrait: full width, crop height
            bw = float(sw); bh = bw / target
        cx = anchor_x * sw
        cy = sh / 2.0
        self.x0 = min(max(cx - bw / 2, 0), sw - bw)
        self.y0 = min(max(cy - bh / 2, 0), sh - bh)
        self.bw, self.bh = bw, bh

    def frame(self, p):
        """Frame at push-in progress p in [0,1] (float-box resample —
        mathematically smooth, no zoompan jitter)."""
        s = 1.0 + (ZOOM - 1.0) * p
        w, h = self.bw / s, self.bh / s
        cx, cy = self.x0 + self.bw / 2, self.y0 + self.bh / 2
        box = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
        fr = self.im.resize((W, H), Image.LANCZOS, box=box)
        if SHARPEN > 0:
            fr = fr.filter(ImageFilter.UnsharpMask(radius=2 * W / 1080,
                                                   percent=SHARPEN,
                                                   threshold=3))
        return fr

def smooth(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)

def scale_alpha(img, f):
    if f >= 0.999:
        return img
    arr = np.asarray(img).copy()
    arr[..., 3] = (arr[..., 3].astype(np.float32) * f).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")

# ================================================================ visual render
def render_visuals(car, photo_paths, out_path):
    """Render the approved visual cut (no audio) and return
    (total_seconds, seq_end_seconds)."""
    shots = [Shot(p) for p in photo_paths]
    durs = [TITLE_DUR] + [SHOT_DUR] * (len(shots) - 1)
    starts, t = [], 0.0
    for dsec in durs:
        starts.append(t); t += dsec
    seq_end = t
    total = seq_end + CARD_DUR
    n_frames = int(round(total * FPS))

    scrim = make_scrim()
    title_ov = make_title_overlay(car)
    lower_ov = make_lowerthird_overlay(car)
    card = make_end_card(car)

    def base_frame(tsec):
        k = len(shots) - 1
        for i, s0 in enumerate(starts):
            if tsec < s0 + durs[i]:
                k = i; break
        local = tsec - starts[k]
        frame = shots[k].frame(min(local / durs[k], 1.0))
        if k > 0 and local < XFADE:
            prev_local = tsec - starts[k - 1]
            prev = shots[k - 1].frame(min(prev_local / durs[k - 1], 1.0))
            frame = Image.blend(prev, frame, smooth(local / XFADE))
        card_a = 0.0
        if tsec >= seq_end - XFADE:
            card_a = smooth((tsec - (seq_end - XFADE)) / XFADE) \
                if tsec < seq_end else 1.0
            frame = Image.blend(frame, card, card_a)
        return frame, card_a

    def title_alpha(tsec):
        if tsec < 0.35:
            return 0.0
        if tsec < 0.9:
            return smooth((tsec - 0.35) / 0.55)
        if tsec < TITLE_DUR:
            return 1.0
        if tsec < TITLE_DUR + XFADE:
            return 1.0 - smooth((tsec - TITLE_DUR) / XFADE)
        return 0.0

    def lower_alpha(tsec):
        if tsec < TITLE_DUR:
            return 0.0
        if tsec < TITLE_DUR + XFADE:
            return smooth((tsec - TITLE_DUR) / XFADE)
        if tsec < seq_end - XFADE:
            return 1.0
        if tsec < seq_end:
            return 1.0 - smooth((tsec - (seq_end - XFADE)) / XFADE)
        return 0.0

    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt",
           "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf",
           str(VIDEO_CRF), "-preset", "medium", "-movflags",
           "+faststart", out_path]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    try:
        for i in range(n_frames):
            tsec = i / FPS
            frame, card_a = base_frame(tsec)
            frame = frame.convert("RGBA")
            if card_a < 1.0:
                frame.alpha_composite(scrim)
                ta = title_alpha(tsec) * (1 - card_a)
                la = lower_alpha(tsec) * (1 - card_a)
                if ta > 0.001:
                    frame.alpha_composite(scale_alpha(title_ov, ta))
                if la > 0.001:
                    frame.alpha_composite(scale_alpha(lower_ov, la))
            frame = frame.convert("RGB")
            g = 1.0
            if tsec < 0.4:
                g = smooth(tsec / 0.4)
            if tsec > total - 0.6:
                g = min(g, 1.0 - smooth((tsec - (total - 0.6)) / 0.6))
            if g < 0.999:
                arr = (np.asarray(frame).astype(np.float32)
                       * g).astype(np.uint8)
                frame = Image.fromarray(arr, "RGB")
            proc.stdin.write(frame.tobytes())
    finally:
        proc.stdin.close()
        proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg visual encode failed")
    return total, seq_end

# ================================================================ spoken words
_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven",
         "eight", "nine", "ten", "eleven", "twelve", "thirteen",
         "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
         "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty",
         "seventy", "eighty", "ninety"]

def _under_1000(n):
    parts = []
    if n >= 100:
        parts += [_ONES[n // 100], "hundred"]
        n %= 100
    if n >= 20:
        parts.append(_TENS[n // 10])
        if n % 10:
            parts.append(_ONES[n % 10])
    elif n > 0:
        parts.append(_ONES[n])
    return parts

def int_words(n):
    """51680 -> 'fifty one thousand six hundred eighty' (spike style:
    space-separated, no hyphens, no 'and')."""
    n = int(n)
    if n == 0:
        return "zero"
    parts = []
    for scale, name in ((1_000_000, "million"), (1_000, "thousand")):
        if n >= scale:
            parts += _under_1000(n // scale) + [name]
            n %= scale
    parts += _under_1000(n)
    return " ".join(p for p in parts if p)

def year_words(y):
    """2026 -> 'twenty twenty six'; 2005 -> 'twenty oh five'."""
    y = int(y)
    if 2000 <= y <= 2099:
        r = y - 2000
        if r == 0:
            return "two thousand"
        if r < 10:
            return "twenty oh " + _ONES[r]
        return "twenty " + int_words(r)
    if 1900 <= y <= 1999:
        r = y - 1900
        if r == 0:
            return "nineteen hundred"
        if r < 10:
            return "nineteen oh " + _ONES[r]
        return "nineteen " + int_words(r)
    return int_words(y)

def decimal_words(s):
    """'2.5' -> 'two point five'; '3.0' -> 'three'; '5' -> 'five'."""
    s = str(s).strip()
    if "." in s:
        whole, frac = s.split(".", 1)
        frac = frac.rstrip("0")
        w = int_words(int(whole)) if whole else "zero"
        if frac:
            digits = " ".join(_ONES[int(d)] for d in frac if d.isdigit())
            return f"{w} point {digits}"
        return w
    return int_words(int(s))

# ================================================================ NHTSA decode
def nhtsa_decode(vin):
    """VIN decode via NHTSA vPIC (public, no key). Returns a dict of
    the fields the script may use — engine/drivetrain ONLY — or {}
    on any failure (the script then falls back to stored facts)."""
    if not vin:
        return {}
    try:
        url = ("https://vpic.nhtsa.dot.gov/api/vehicles/"
               f"decodevinvalues/{vin}?format=json")
        req = urllib.request.Request(url,
                                     headers={"User-Agent": "AutoLaunch"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode())
        r = (data.get("Results") or [{}])[0]
        if str(r.get("ErrorCode", "0")).split(",")[0].strip() not in ("0", ""):
            return {}
        return {k: (r.get(k) or "").strip() for k in
                ("DisplacementL", "DriveType", "ElectrificationLevel",
                 "FuelTypePrimary")}
    except Exception:
        return {}

def _powertrain_phrase(decode):
    """(phrase or None) from decode facts only."""
    if not decode:
        return None
    disp = decode.get("DisplacementL") or ""
    elec = (decode.get("ElectrificationLevel") or "").lower()
    fuel = (decode.get("FuelTypePrimary") or "").lower()
    hybrid = ("hev" in elec or "hybrid" in elec or "phev" in elec)
    if fuel == "electric" and not hybrid:
        return "an all electric powertrain"
    if disp:
        base = f"a {decimal_words(disp)} liter"
        return base + (" hybrid powertrain" if hybrid else " powertrain")
    if hybrid:
        return "a hybrid powertrain"
    return None

def _drivetrain_phrase(decode):
    if not decode:
        return None
    dt = (decode.get("DriveType") or "")
    low = dt.lower()
    if "awd" in low or "all-wheel" in low or "all wheel" in low:
        return "all wheel drive"
    if "4wd" in low or "4-wheel" in low or "4x4" in low \
            or "four-wheel" in low:
        return "four wheel drive"
    if "fwd" in low or "front" in low:
        return "front wheel drive"
    if "rwd" in low or "rear" in low:
        return "rear wheel drive"
    return None

# ================================================================ script writer
def build_script(car, decode):
    """Facts-only narration, ~55-70 spoken words. Sources: the stored
    row (year/make/model/colors/miles/price/dealership) + the NHTSA
    decode (engine/drivetrain only). The stored trim string is NEVER
    used (it is corrupted in the data). Nothing is invented: a fact
    with no source is simply not said.
    Returns a list of segment dicts: {id, text}."""
    dealer = car.get("_dealership") or ""
    name = _car_name(car)
    segs = []
    a = f"This is a {year_words(car['year'])} {car['make']} {car['model']}"
    if dealer:
        a += f" at {dealer}"
    segs.append({"id": "A", "text": a + "."})
    clauses = []
    if car.get("color"):
        clauses.append(f"finished in {car['color']}")
    interior = (car.get("interior_color") or "").split(",")[0].strip()
    if interior:
        # Fully lowercased for the spoken sentence: first-letter-only
        # produced "a jet Black interior" on the Silverado E2E.
        clauses.append(f"with a {interior.lower()} interior")
    if clauses:
        segs.append({"id": "B",
                     "text": "It's " + ", ".join(clauses) + "."})
    c_bits = []
    pt = _powertrain_phrase(decode)
    dt = _drivetrain_phrase(decode)
    if pt:
        s = f"It runs {pt}"
        if dt:
            s += f" with {dt}"
        if car.get("mileage"):
            s += f", and it has {int_words(car['mileage'])} miles."
        else:
            s += "."
        c_bits.append(s)
    elif car.get("mileage"):
        c_bits.append(f"It has {int_words(car['mileage'])} miles.")
    if c_bits:
        segs.append({"id": "C", "text": " ".join(c_bits)})
    if car.get("price"):
        segs.append({"id": "D1",
                     "text": f"Priced at {int_words(car['price'])} "
                             f"dollars."})
    if dealer:
        segs.append({"id": "D2", "text": f"At {dealer}."})
    return segs

# ================================================================ TTS + placement
def _ffprobe_duration(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path], capture_output=True, text=True).stdout
    return float(out.strip())

def speech_span(path):
    """(lead_in, speech_seconds) of the actual voice in a TTS file:
    the union of ALL speech islands between silencedetect gaps
    (-45 dB, d=0.15 — the spike's threshold/duration), i.e. first
    island start to last island end. Placement and the QA gate refer
    to measured speech, never file edges. (An earlier first-dip
    version truncated spans at the first comma pause — the Silverado
    E2E measured a 4-second sentence as 0.66s; island union is the
    correct span.)"""
    dur = _ffprobe_duration(path)
    out = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", path, "-af",
         "silencedetect=noise=-45dB:d=0.15", "-f", "null", "-"],
        capture_output=True, text=True).stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", out)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", out)]
    # Silence intervals [start, end); a trailing silence may have no end.
    intervals = []
    for i, s in enumerate(starts):
        intervals.append((s, ends[i] if i < len(ends) else dur))
    # Speech islands = the complement of the silence intervals.
    islands, cursor = [], 0.0
    for s, e in intervals:
        if s > cursor:
            islands.append((cursor, s))
        cursor = max(cursor, e)
    if cursor < dur:
        islands.append((cursor, dur))
    islands = [(a, b) for a, b in islands if b - a >= 0.12]
    if not islands:
        return 0.0, max(0.3, dur)
    return islands[0][0], max(0.3, islands[-1][1] - islands[0][0])

def synthesize(segs, workdir):
    """Render each segment with Helio; attach file + measured span."""
    for seg in segs:
        out = os.path.join(workdir, f"seg{seg['id']}.mp3")
        p = subprocess.run([TTS_BIN, "speak", "--output", out,
                            "--voice", VOICE_ID, "--text-stdin"],
                           input=seg["text"], capture_output=True,
                           text=True, timeout=180)
        if p.returncode != 0 or not os.path.exists(out):
            raise RuntimeError(f"TTS failed for segment {seg['id']}: "
                               f"{(p.stdout or '')[:200]} "
                               f"{(p.stderr or '')[:200]}")
        lead, dur = speech_span(out)
        seg.update({"file": out, "lead": lead, "dur": dur})
    return segs

def place_segments(segs, total, seq_end):
    """Assign each segment a speech onset on the video timeline:
    A over the title card, B/C across the walkaround, the price line
    landing on the end card (the approved spike placement, anchored
    to the end so any photo count works)."""
    by_id = {s["id"]: s for s in segs}
    d1 = by_id.get("D1")
    d2 = by_id.get("D2")
    if d1:
        d1["onset"] = total - 5.2
        if d1["onset"] + d1["dur"] > total - 0.55:
            d1["onset"] = total - 0.55 - d1["dur"]
    if d2 and d1:
        d2["onset"] = max(total - 1.85, d1["onset"] + d1["dur"] + 0.35)
        if d2["onset"] + d2["dur"] > total - 0.30:
            d2["onset"] = total - 0.30 - d2["dur"]
    elif d2:
        d2["onset"] = total - 1.85
    if "A" in by_id:
        by_id["A"]["onset"] = 1.00
    if "B" in by_id:
        by_id["B"]["onset"] = max(4.6, round(seq_end * 0.18, 2))
    c = by_id.get("C")
    if c:
        latest = (d1["onset"] if d1 else total - 2.0) - c["dur"] - 1.0
        earliest = 3.0
        if "B" in by_id:
            earliest = by_id["B"]["onset"] + by_id["B"]["dur"] + 0.7
        c["onset"] = min(round(seq_end * 0.42, 2), latest)
        if c["onset"] < earliest:
            c["dropped"] = True  # no room on a very short reel
    return [s for s in segs if not s.get("dropped")]

def build_voice_stem(segs, total, workdir):
    inputs, filters = [], []
    live = [s for s in segs if "onset" in s]
    for i, seg in enumerate(live):
        inputs += ["-i", seg["file"]]
        delay_ms = int(round((seg["onset"] - seg["lead"]) * 1000))
        filters.append(f"[{i}:a]aresample=48000,"
                       f"adelay={max(0, delay_ms)}:all=1[s{i}]")
    mix = "".join(f"[s{i}]" for i in range(len(live)))
    filters.append(f"{mix}amix=inputs={len(live)}:normalize=0,"
                   f"pan=stereo|c0=c0|c1=c0,apad,atrim=0:{total:.3f}[stem]")
    out = os.path.join(workdir, "vo_stem.wav")
    subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs,
                    "-filter_complex", ";".join(filters), "-map", "[stem]",
                    "-c:a", "pcm_s16le", out], check=True)
    return out

# ================================================================ audio chain
# THE canonical mix — the exact recipe of the approved hand-remix:
# ducked bed + voice at native gains, ONE uniform makeup gain to a
# -1.5 dB peak. No loudnorm, no dynamics on the sum, ever.
def build_bed(total, workdir):
    out = os.path.join(workdir, "bed.wav")
    af = (f"aresample=48000,volume=0.30,afade=t=in:st=0:d=1.2,"
          f"afade=t=out:st={total - 2.2:.2f}:d=2.2,"
          f"apad,atrim=0:{total:.3f}")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-stream_loop", "-1",
                    "-i", MUSIC_BED, "-af", af, "-c:a", "pcm_s16le", out],
                   check=True)
    return out

def build_ducked_bed(bed_wav, stem_wav, workdir):
    out = os.path.join(workdir, "ducked_bed.wav")
    graph = ("[0:a][1:a]sidechaincompress=threshold=0.02:ratio=6:"
             "attack=20:release=400:makeup=1[duck]")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", bed_wav,
                    "-i", stem_wav, "-filter_complex", graph,
                    "-map", "[duck]", "-c:a", "pcm_s16le", out],
                   check=True)
    return out

def _peak_db(path):
    out = subprocess.run(["ffmpeg", "-v", "info", "-i", path, "-af",
                          "astats", "-vn", "-f", "null", "-"],
                         capture_output=True, text=True).stderr
    peaks = [float(x) for x in re.findall(r"Peak level dB: (-?[\d.]+|-inf)",
                                          out)]
    peaks = [p for p in peaks if p > -90]
    return max(peaks) if peaks else -90.0

def mix_final(silent_mp4, ducked_wav, stem_wav, total, workdir):
    """Sum ducked bed + voice at native gains, measure the peak, apply
    ONE uniform gain to PEAK_TARGET_DB, mux with the silent video.
    Returns (final_mp4, peak_db_before_gain, gain_db)."""
    mix_raw = os.path.join(workdir, "mix_raw.wav")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", ducked_wav,
                    "-i", stem_wav, "-filter_complex",
                    "[0:a][1:a]amix=inputs=2:normalize=0[mix]",
                    "-map", "[mix]", "-c:a", "pcm_s16le", mix_raw],
                   check=True)
    peak = _peak_db(mix_raw)
    gain = round(PEAK_TARGET_DB - peak, 2)
    final = os.path.join(workdir, "final.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", silent_mp4,
                    "-i", mix_raw, "-map", "0:v", "-map", "1:a",
                    "-c:v", "copy", "-af", f"volume={gain}dB",
                    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                    "-t", f"{total:.3f}", "-movflags", "+faststart",
                    final], check=True)
    return final, peak, gain

# ================================================================ size gate
def enforce_size_gate(final_mp4, workdir):
    """Hard finished-file size gate (Matthew, 2026-11-06): Facebook's
    vehicle composer silently drops oversized reels — proven at the
    desk, where 20.7-22.7 MB reels never ingested via the helper or
    by hand while a 3.8 MB copy of the same reel attached instantly.
    An oversized render must therefore never reach the upload. If
    the delivered file exceeds SIZE_LIMIT_BYTES, re-encode the video
    ONCE at SIZE_RETRY_CRF (the audio is copied bit-identical, so
    the canonical mix and its QA are untouched); if it is STILL
    over, raise — the row finishes 'failed' with the reason instead
    of uploading a file that cannot post. Runs BEFORE qa_gate so
    the QA gate measures the exact delivered artifact.
    Returns (path, info) — info rides the row's qa."""
    size = os.path.getsize(final_mp4)
    info = {"limit_bytes": SIZE_LIMIT_BYTES, "initial_bytes": size,
            "reencoded": False}
    if size <= SIZE_LIMIT_BYTES:
        info["final_bytes"] = size
        return final_mp4, info
    smaller = os.path.join(workdir, "final_small.mp4")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", final_mp4,
                    "-map", "0:v", "-map", "0:a", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", "-crf", str(SIZE_RETRY_CRF),
                    "-preset", "medium", "-c:a", "copy",
                    "-movflags", "+faststart", smaller], check=True)
    size2 = os.path.getsize(smaller)
    info.update({"reencoded": True, "retry_crf": SIZE_RETRY_CRF,
                 "final_bytes": size2})
    if size2 > SIZE_LIMIT_BYTES:
        raise RuntimeError(
            f"finished reel is {size2 / 1e6:.1f} MB after the "
            f"size-gate re-encode (limit "
            f"{SIZE_LIMIT_BYTES // (1024 * 1024)} MB) — refusing to "
            "upload an oversized file Facebook will not ingest")
    return smaller, info

# ================================================================ QA gate
def mean_volume_db(path, start, dur):
    out = subprocess.run(
        ["ffmpeg", "-v", "info", "-ss", f"{start:.2f}", "-t",
         f"{dur:.2f}", "-i", path, "-af", "volumedetect", "-vn",
         "-f", "null", "-"], capture_output=True, text=True).stderr
    m = re.search(r"mean_volume: (-?[\d.]+|-inf) dB", out)
    if not m or m.group(1) == "-inf":
        return -90.0
    return float(m.group(1))

def qa_gate(final_mp4, ducked_wav, segs, total, gain_db=0.0):
    """Finished-file gate — measures the DELIVERED artifact, never the
    stems. The bed reference is the ducked-bed stem GAIN-MATCHED by the
    mix's one uniform makeup gain (gain_db): inside the final file the
    bed sits at stem + gain, so deltas isolate the voice. Speech
    windows must read >= +6 dB of final-over-bed (the voice audibly on
    top); a stem-silent gap window must read as bed alone (+/- 1.5 dB).
    Returns (passed, qa_dict)."""
    qa = {"voice": VOICE_ID, "total_s": round(total, 2),
          "gain_db": gain_db}
    probe = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_type,codec_name,width,height",
         "-show_entries", "format=duration", "-of", "json", final_mp4],
        capture_output=True, text=True).stdout)
    streams = probe.get("streams", [])
    vid = next((s for s in streams if s.get("codec_type") == "video"), {})
    aud = next((s for s in streams if s.get("codec_type") == "audio"), None)
    dur = float(probe.get("format", {}).get("duration", 0))
    qa["duration_s"] = round(dur, 2)
    qa["video"] = {"codec": vid.get("codec_name"),
                   "width": vid.get("width"), "height": vid.get("height")}
    probe_ok = (vid.get("codec_name") == "h264"
                and vid.get("width") == W and vid.get("height") == H
                and aud is not None and abs(dur - total) <= 0.6)
    qa["probe_ok"] = probe_ok

    speech_checks = []
    for seg in segs:
        if "onset" not in seg:
            continue
        w0 = seg["onset"] + 0.15
        wlen = max(0.5, seg["dur"] - 0.25)
        mix_db = mean_volume_db(final_mp4, w0, wlen)
        bed_db = mean_volume_db(ducked_wav, w0, wlen) + gain_db
        delta = round(mix_db - bed_db, 1)
        speech_checks.append({
            "segment": seg["id"], "window": [round(w0, 2),
                                             round(w0 + wlen, 2)],
            "mix_db": mix_db, "bed_db": bed_db, "delta_db": delta,
            "pass": delta >= 6.0})
    qa["speech_checks"] = speech_checks

    spans = sorted((s["onset"], s["onset"] + s["dur"])
                   for s in segs if "onset" in s)
    gaps, cursor = [], 1.0
    for a, b in spans:
        if a > cursor:
            gaps.append((cursor, a))
        cursor = max(cursor, b)
    if cursor < total - 0.8:
        gaps.append((cursor, total - 0.8))
    gaps = [(a, b) for a, b in gaps if b - a >= 1.2]
    if gaps:
        a, b = max(gaps, key=lambda g: g[1] - g[0])
        w0 = a + (b - a) * 0.2
        wlen = (b - a) * 0.6
        mix_db = mean_volume_db(final_mp4, w0, wlen)
        bed_db = mean_volume_db(ducked_wav, w0, wlen) + gain_db
        delta = round(mix_db - bed_db, 1)
        qa["gap_check"] = {"window": [round(w0, 2), round(w0 + wlen, 2)],
                           "mix_db": mix_db, "bed_db": bed_db,
                           "delta_db": delta, "pass": abs(delta) <= 1.5}
    else:
        qa["gap_check"] = {"skipped": True,
                           "reason": "no stem-silent gap >= 1.2s"}
    gap_ok = qa["gap_check"].get("skipped") or qa["gap_check"]["pass"]
    qa["passed"] = bool(probe_ok and speech_checks
                        and all(c["pass"] for c in speech_checks) and gap_ok)
    return qa["passed"], qa

# ================================================================ generate
def generate(row, keep_work=False):
    row_id, user_id, vin = row["id"], row["user_id"], row["vin"]
    row_claim(row_id)
    car = fetch_car(user_id, vin=vin)
    car["user_key"] = user_id
    car["_dealership"] = fetch_dealership(user_id)
    car["_contact"] = fetch_contact(user_id)
    urls = photo_list(car)
    if len(urls) < MIN_PHOTOS:
        raise RuntimeError(
            f"only {len(urls)} usable photos (need {MIN_PHOTOS})")
    paths = download_photos(car, urls[:MAX_PHOTOS])

    workdir = tempfile.mkdtemp(prefix=f"vinreel-{row_id[:8]}-")
    try:
        silent = os.path.join(workdir, "silent.mp4")
        total, seq_end = render_visuals(car, paths, silent)
        print(f"  visuals: {total:.2f}s ({len(paths)} photos)")

        decode = nhtsa_decode(car["vin"])
        segs = build_script(car, decode)
        if not segs:
            raise RuntimeError("script writer produced no segments")
        synthesize(segs, workdir)
        segs = place_segments(segs, total, seq_end)
        stem = build_voice_stem(segs, total, workdir)
        bed = build_bed(total, workdir)
        ducked = build_ducked_bed(bed, stem, workdir)
        final, peak, gain = mix_final(silent, ducked, stem, total,
                                      workdir)
        final, size_info = enforce_size_gate(final, workdir)
        if size_info["reencoded"]:
            print(f"  size gate: {size_info['initial_bytes']} B over "
                  f"the limit — re-encoded at crf {SIZE_RETRY_CRF} "
                  f"to {size_info['final_bytes']} B")
        passed, qa = qa_gate(final, ducked, segs, total, gain_db=gain)
        qa["size_gate"] = size_info
        qa["script"] = [s["text"] for s in segs]
        qa["segments"] = [{"id": s["id"],
                           "onset": round(s["onset"], 2),
                           "dur": round(s["dur"], 2)}
                          for s in segs if "onset" in s]
        qa["peak_db_before_gain"] = peak
        qa["gain_db"] = gain
        qa["file_size_bytes"] = os.path.getsize(final)
        print(f"  audio: peak {peak:.1f} dB, gain {gain:+.1f} dB, "
              f"QA {'PASS' if passed else 'FAIL'}")
        if not passed:
            bad = [c["segment"] for c in qa["speech_checks"]
                   if not c["pass"]]
            row_finish(row_id, "failed",
                       error="audio QA gate failed on the finished "
                             f"file (speech windows: {bad or 'n/a'}; "
                             f"gap: {qa['gap_check']})",
                       qa=qa)
            return 1
        url = storage_upload(user_id, vin, final)
        row_finish(row_id, "ready", video_url=url, qa=qa)
        print(f"  ready: {url}")
        return 0
    finally:
        if not keep_work:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)
        else:
            print(f"  work kept: {workdir}")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--row-id", default=None)
    ap.add_argument("--user-id", default=None)
    ap.add_argument("--stock", default=None)
    ap.add_argument("--vin", default=None)
    ap.add_argument("--keep-work", action="store_true")
    args = ap.parse_args()

    row = None
    try:
        if args.row_id:
            row = row_get(args.row_id)
            if not row:
                raise RuntimeError(f"vin_reels row {args.row_id} not found")
            if row["status"] in ("ready", "failed"):
                print(f"row already {row['status']} — nothing to do")
                return 0
        elif args.user_id and (args.stock or args.vin):
            car = fetch_car(args.user_id, vin=args.vin, stock=args.stock)
            row = row_insert(args.user_id, car["vin"],
                             car["stock_number"])
            if row["status"] == "ready":
                print(f"live row already ready: {row.get('video_url')}")
                return 0
        else:
            ap.error("give --row-id, or --user-id with --stock/--vin")
        return generate(row, keep_work=args.keep_work)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        if row:
            try:
                row_finish(row["id"], "failed", error=str(e))
            except Exception as e2:
                print(f"could not mark row failed: {e2}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
