# Tomorrow Checklist — AutoLaunch rebuild (PC + phone)
## Extension reload
1. Download https://github.com/mdemoss-bdc/AutoLaunch/archive/refs/heads/main.zip and unzip → chrome://extensions → Reload on the AutoLaunch card → version reads 2.1.11.
2. Go to the AutoLaunch app tab → Ctrl+Shift+R → app reloads fresh on the new build.
## Setup page
3. Sidebar → Chrome Extension → status card shows "Helper ready" (after the reload above + a signed-in app tab).
4. If the card says waiting instead → hard-refresh the app tab (Ctrl+Shift+R) → status flips to "Helper ready".
## Posting
5. Queue one car WITH photos → helper fills the form and, in confirm mode, the banner asks you to click Publish → queue shows posted + the car flips to Posted.
6. Try to queue a car with NO photos → its row shows "No photo — can't post" and it never queues.
## Deleting (the big one)
7. On a live posted car → Remove from Facebook → watch it run → the listing is removed and the queue row completes.
8. If it fails → read the queue row's error, which now names the exact stage (menu_items_seen etc.) → tell Luna that stage note.
## Empty-page delete
9. Only if a listing was already deleted by hand: queue a removal for it → it completes as already-gone, not failed.
## Auto-delete
10. On a posted car → ⋯ menu → Mark as sold → Sold chip shows "Sold — removal queued" → the listing disappears from Facebook by itself.
## Screens & filters
11. Click the Posted pill → its count equals the cars shown, and a sold-but-posted car appears there with its Sold chip.
12. Click Active, then Unposted → neither list shows the sold car.
13. Open every modal (Settings and all its tabs, Photo Edits, Guides) → all dark, text readable.
14. Settings → Appearance → switch theme to Arctic (light) → modals are readable there too → switch back.
## Wishlist
15. Add a want that matches a car in stock → match badge and/or toast appears for it.
16. Mark that matching car sold → it stops matching the want.
## Webhook (2 minutes, optional)
17. Do the GITHUB_PAT step in supabase/WEBHOOK_SETUP.md → click Sync in the app → a run appears in GitHub → Actions.
