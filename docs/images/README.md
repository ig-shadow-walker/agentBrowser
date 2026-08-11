# Screenshots

Images used by the root `README.md`.

| File | Source | Notes |
| --- | --- | --- |
| `logo.png` | `app/src-tauri/icons/icon.png` | The app icon, unmodified |
| `menu-bar.png` | full-screen capture, cropped | Icon + open menu, 407×160 |
| `panel.png` | window capture, halved | The control panel, 449×622 |

Screen captures are taken on a Retina display and halved, so they render at their
intended size on GitHub rather than at double scale.

## Regenerating from a fresh capture

Crop coordinates are read off the full-screen capture, so they only hold for that
particular screenshot. To redo one, capture again and adjust the box:

```python
from PIL import Image
im = Image.open("<the capture>")
crop = im.crop((left, top, right, bottom))
crop = crop.resize((crop.width // 2, crop.height // 2), Image.LANCZOS)
crop.save("docs/images/menu-bar.png", optimize=True)
```

## Two things to check before committing a new capture

**Credential names are visible in the panel.** They are names, not values — but a
name can still reveal an internal system. Use throwaway names like
`MY_APP_PASSWORD` for screenshots, not real ones.

**Full-screen Retina captures are 15–20MB each.** Keep only the cropped
derivatives in the repo. Git never forgets a blob, so a large file committed once
stays in the history permanently.

## Still wanted

`agent-in-action.png` — Claude Code completing a real task through the tool,
ideally including an upload, since that is the capability the project exists for.
More persuasive than either screenshot above. `test/fixture-server.mjs` is a
miniature internal app with a login form and two upload paths built for exactly
this, if there is nothing shareable from a real system.
