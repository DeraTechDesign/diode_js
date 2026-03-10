# Relay Selection Benchmark Report

- Generated: 2026-03-06T12:46:18.317Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: snapshot
- Network discovery snapshot: `C:\Users\4ever\Documents\GitHub\diode_js\reports\dio-network-snapshot.json`

## Summary

- Average connect time: old 2502.3 ms, current 5542.74 ms
- Average selected relay RTT: old 184.2 ms, current 17.74 ms
- Average best connected RTT: old 17.96 ms, current 17.74 ms
- Average gap to best: old 166.24 ms, current 0 ms
- Average device resolution: old 187.19 ms, current 29.46 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 3553.35 | 6 | as2.prenet.diode.io:41046 | seed | 183.54 | eu1.prenet.diode.io:41046 | 11.08 | 172.47 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 185.76 |
| cold | current | 5013.05 | 3 | eu1.prenet.diode.io:41046 | seed | 12.63 | eu1.prenet.diode.io:41046 | 12.63 | 0 | 2 | 2 | us2.prenet.diode.io:41046 | seed | 31.09 |
| warm-1 | old | 1904.57 | 6 | as2.prenet.diode.io:41046 | seed | 179.93 | eu1.prenet.diode.io:41046 | 24.13 | 155.8 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 189.98 |
| warm-1 | current | 5932.47 | 3 | eu1.prenet.diode.io:41046 | seed | 24.95 | eu1.prenet.diode.io:41046 | 24.95 | 0 | 2 | 2 | 144.126.157.138:41046 | network | 26.37 |
| warm-2 | old | 2048.98 | 6 | as2.prenet.diode.io:41046 | seed | 189.12 | eu1.prenet.diode.io:41046 | 18.66 | 170.46 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 185.84 |
| warm-2 | current | 5682.71 | 3 | eu1.prenet.diode.io:41046 | seed | 15.65 | eu1.prenet.diode.io:41046 | 15.65 | 0 | 2 | 2 | 144.126.157.138:41046 | network | 30.91 |
