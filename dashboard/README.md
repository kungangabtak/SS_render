# Hole Cards Dashboard

A minimal **vanilla HTML/CSS/JS** dashboard that connects to your Render WebSocket hub as `role=sub` and displays the latest **2 hole cards** from incoming messages.

## Multi-Publisher Support

This dashboard now supports **multiple publishers** (multiple people running the Chrome extension in the same PokerNow room). Features include:

- **Publishers Panel**: Shows all active publishers with their player name, PokerNow player ID, last seen time, and latest hand preview
- **Player Names**: Displays the player's actual PokerNow display name (e.g., "Kunga") instead of just an ID
- **Click to Select**: Click any publisher card to view their detailed data
- **Auto-Selection**: Automatically selects the most recently seen publisher
- **JSON Viewer**: View all message types (hand, state, etc.) from the selected publisher
- **Real-time Updates**: Publisher cards update with "seconds ago" timestamps

## Hub URL

This dashboard is pre-configured to connect to: **`wss://dom-hub.onrender.com/`**

## How to run locally

- Open `dashboard/index.html` in your browser.
- Fill in:
  - **Hub WSS base** (default: `wss://dom-hub.onrender.com/`)
  - **Game ID (Room)** (paste full PokerNow URL or just the game ID, e.g., `pglQ2HgWGgYbDUSq7f9moVbXR`)
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

## Message Format

The Chrome extension publisher includes `publisherId` and `playerName` fields on every hub message at the top level:

```json
{
  "publisherId": "449iYoPwk6",
  "playerName": "Kunga",
  "type": "hand",
  "data": {
    "value1": "J",
    "suit1": "h",
    "value2": "J",
    "suit2": "s",
    "url": "https://www.pokernow.club/games/...",
    "timestamp": 1702847123456
  },
  "timestamp": 1702847123456
}
```

### Field Descriptions

| Field | Description |
|-------|-------------|
| `publisherId` | The PokerNow player ID extracted from the page (e.g., `449iYoPwk6` from `/players/449iYoPwk6`). Falls back to a generated UUID if the player ID cannot be extracted. |
| `playerName` | The player's display name as shown on PokerNow (e.g., `Kunga`). |
| `type` | Message type: `hand` for hole cards, `state` for game state, etc. |
| `data` | Message payload (varies by type). |
| `timestamp` | Unix timestamp in milliseconds. |

Messages without a `publisherId` are bucketed under `"unknown"`.

## Connection

- **Single WebSocket**: The dashboard maintains one WebSocket connection to the hub
- **Format**: `wss://dom-hub.onrender.com/?room=<ROOM>&role=sub&token=<TOKEN>`
- **Auto-reconnect**: Exponential backoff (500ms → 1s → 2s → 4s → 8s → 10s cap)

## Connection Status Indicator

The status badge shows:
- 🟢 **connected** — WebSocket is open and receiving messages
- 🟡 **reconnecting** — Attempting to reconnect (with pulse animation)
- 🔴 **disconnected** — Not connected (manual disconnect or failed)

## Notes

- The WS URL format used is:

  `wss://dom-hub.onrender.com/?role=sub&room=pglQ2HgWGgYbDUSq7f9moVbXR&token=HUB_TOKEN`

- The `room` parameter (mapped from the Game ID input) is required to match the room the publisher is using. The token must match the `HUB_TOKEN` environment variable set on your Render service.

- The UI shows:
  - Connection status (connected / disconnected / reconnecting)
  - Publishers panel with all active extension instances, showing player names and PokerNow IDs
  - Latest two card tiles for selected publisher using suit symbols (♥ ♦ ♣ ♠)
  - Selected publisher info with player name (e.g., "Kunga (449iYoPw)")
  - JSON viewer showing all message types from selected publisher
  - Last update time (prefers `data.timestamp`, falls back to top-level `timestamp`)
  - Table URL link (`data.url`) when present
  - A small expandable log (~50 rows) with a **Clear log** button
