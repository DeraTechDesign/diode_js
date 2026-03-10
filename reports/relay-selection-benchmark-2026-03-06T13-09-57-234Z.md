# Relay Selection Benchmark Report

- Generated: 2026-03-06T13:09:57.235Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: live
- Benchmark profile: startup discovery only; background discovery probing disabled for deterministic timing

## Summary

- Average connect time: old 2055.15 ms, current 4468.85 ms
- Average selected relay RTT: old 177.27 ms, current 15.23 ms
- Average best connected RTT: old 16.98 ms, current 12.91 ms
- Average gap to best: old 160.29 ms, current 2.32 ms
- Average device resolution: old 201.62 ms, current 196.27 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2156.36 | 6 | as2.prenet.diode.io:41046 | seed | 185.42 | eu1.prenet.diode.io:41046 | 18.39 | 167.02 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 239.54 |
| cold | current | 4844.13 | 3 | eu1.prenet.diode.io:41046 | seed | 14.4 | eu1.prenet.diode.io:41046 | 14.4 | 0 | 159 | 2 | us2.prenet.diode.io:41046 | seed | 297.44 |
| warm-1 | old | 2043.59 | 6 | as2.prenet.diode.io:41046 | seed | 179.41 | eu1.prenet.diode.io:41046 | 21.35 | 158.07 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 185.05 |
| warm-1 | current | 4730.68 | 3 | 100.42.185.199:41046 | network | 14.98 | eu1.prenet.diode.io:41046 | 13.6 | 1.37 | 153 | 2 | us2.prenet.diode.io:41046 | seed | 264.61 |
| warm-2 | old | 1965.5 | 6 | as2.prenet.diode.io:41046 | seed | 166.97 | eu1.prenet.diode.io:41046 | 11.19 | 155.78 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 180.27 |
| warm-2 | current | 3831.73 | 3 | 100.42.185.199:41046 | network | 16.31 | eu1.prenet.diode.io:41046 | 10.71 | 5.6 | 166 | 2 | us2.prenet.diode.io:41046 | seed | 26.77 |
