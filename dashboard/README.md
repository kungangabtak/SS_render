# Render WebSocket Hub Dashboard (Static)

A minimal **vanilla HTML/CSS/JS** dashboard that connects to your Render WebSocket hub as **`role=sub`** and displays the latest **two hole cards** from incoming messages.

## Run locally

- Open `dashboard/index.html` directly in your browser.
- Optionally prefill via query params (and auto-connect):

`index.html?hub=wss%3A%2F%2FYOUR-HUB.onrender.com%2F&room=ROOM&token=HUB_TOKEN`

## Deploy on Render Static Site

- **Build command**: *(none)*
- **Publish directory**: `dashboard`

## WebSocket URL format

The dashboard builds the WS URL as:

`wss://YOUR-HUB.onrender.com/?room=ROOM&role=sub&token=HUB_TOKEN`

## Incoming message shape (example)

```json
{
  "type": "hand",
  "data": {
    "value1": "J",
    "suit1": "h",
    "value2": "J",
    "suit2": "s",
    "url": "https://www.pokernow.club/games/ROOM",
    "timestamp": 1765982556547
  },
  "timestamp": 1765982556548
}
```


