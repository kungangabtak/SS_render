# Hole Cards Dashboard

A minimal **vanilla HTML/CSS/JS** dashboard that connects to your Render WebSocket hub as `role=sub` and displays the latest **2 hole cards** from incoming messages.

## Hub URL

This dashboard is pre-configured to connect to: **`wss://dom-hub.onrender.com/`**

## How to run locally

- Open `dashboard/index.html` in your browser.
- Fill in:
  - **Hub WSS base** (default: `wss://dom-hub.onrender.com/`)
  - **Game ID** (paste full PokerNow URL or just the game ID, e.g., `pglQ2HgWGgYbDUSq7f9moVbXR`)
  - **Token** (your HUB_TOKEN)
- Click **Connect**.

No build step, no server required.

### Game ID extraction

The dashboard automatically extracts the game ID from PokerNow URLs:
- Full URL: `https://www.pokernow.club/games/pglQ2HgWGgYbDUSq7f9moVbXR`
- Extracted ID: `pglQ2HgWGgYbDUSq7f9moVbXR`

You can paste either format—the dashboard will extract just the ID.

## Query-string support (auto-prefill + auto-connect)

If you open the page with these query params, the inputs will be prefilled and it will auto-connect:

- `hub` (your base hub URL)
- `gameId` (the PokerNow game/room ID)
- `token` (your HUB_TOKEN)

Example:

`index.html?hub=wss://dom-hub.onrender.com/&gameId=pglQ2HgWGgYbDUSq7f9moVbXR&token=HUB_TOKEN`

## Deploy on Render Static Site

1. Create a new **Static Site** on Render.
2. Point it at this repo.
3. Configure:
   - **Build Command**: (leave empty)
   - **Publish Directory**: `dashboard`

That's it — Render will serve `dashboard/index.html`.

## Notes

- The WS URL format used is:

  `wss://dom-hub.onrender.com/?role=sub&room=pglQ2HgWGgYbDUSq7f9moVbXR&token=HUB_TOKEN`

- The `room` parameter (mapped from the Game ID input) is required to match the room the publisher is using. The token must match the `HUB_TOKEN` environment variable set on your Render service.

- The UI shows:
  - Connection status (connected / disconnected / reconnecting)
  - Latest two card tiles using suit symbols (♥ ♦ ♣ ♠)
  - Last update time (prefers `data.timestamp`, falls back to top-level `timestamp`)
  - Table URL link (`data.url`) when present
  - A small expandable log (~50 rows) with a **Clear log** button

