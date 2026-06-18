Drop optional replacement sound files here.

The static demo currently uses WebAudio for coin and engine sounds, so it works without binary assets. If you add `coin.wav` or `engine.wav`, you can swap the WebAudio helpers in `site/play-demo.html` to use `new Audio('./assets/sfx/coin.wav')` or `new Audio('./assets/sfx/engine.wav')`.
