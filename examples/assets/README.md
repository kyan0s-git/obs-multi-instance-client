# Example overlays

Copy anything here into your workspace `assets/` folder (or use **HTML sources →
Import files**) and it is served to every instance immediately.

- **`fleet-tally.html`** — reads `/__fleet/instances.json` to draw a tile per
  instance in the fleet, highlighting whichever instance is rendering it. A
  worked example of one overlay file serving the whole fleet.

Two things are available to every served page:

```js
window.OBSFleet          // { instance, instanceId, role, color }
fetch('/__fleet/instances.json')   // the whole roster
```

Editing a file here reloads every browser source currently showing it.
