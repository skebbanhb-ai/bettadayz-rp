Drop optional replacement sound files here.

The static demo currently uses WebAudio for the coin sound, so it works without a binary asset. If you add `coin.wav`, you can swap `playCoinSound()` in `site/play-demo.html` to use `new Audio('./assets/sfx/coin.wav')`.
