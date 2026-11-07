---
'@hyper-effect/core': patch
'@hyper-effect/island': patch
'create-hyper-effect': patch
---

`OnScroll` posts the final scroll position: its 150 ms throttle now also fires on the trailing edge, so a page that renders what is in view (a server-windowed list) no longer stops short of where scrolling ended.
