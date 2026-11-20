# Working on this game

## The test hook

So a game can be checked by reading numbers, not by looking at it:

- The game keeps its state on `window.__game`: at least the player's
  position (`player.x`, `player.y`), `lives`, `score`, `level`, and the
  current `scene` (`"title"`, `"playing"`, `"won"`, `"over"`).
- With `?test` in the URL (`index.html?test`), the game seeds its random
  numbers (a small seeded generator, not `Math.random`) and steps the
  simulation on a fixed timestep (1/60 s per frame), so the same keys give
  the same numbers every run.

Check behaviour with `ys_check_page` steps and `eval`, for example:

```json
{
  "target": "index.html?test",
  "steps": [{"key": "ArrowRight", "hold_ms": 500}, {"key": "Space"}, {"wait_ms": 300}],
  "eval": "({x: __game.player.x, y: __game.player.y, scene: __game.scene})"
}
```

## Checking

- Load the page with `ys_check_page` after each change; fix every exception
  and console error it reports before going on.
- Keep everything drawn with canvas shapes; there are no image files.
