# Relay Selection Benchmark Report

- Generated: 2026-03-06T12:51:41.892Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: snapshot
- Network discovery snapshot: `C:\Users\4ever\Documents\GitHub\diode_js\reports\dio-network-snapshot.json`

## Summary

- Average connect time: old 2987.02 ms, current 6254.23 ms
- Average selected relay RTT: old 180.85 ms, current 14.63 ms
- Average best connected RTT: old 13.46 ms, current 14.63 ms
- Average gap to best: old 167.39 ms, current 0 ms
- Average device resolution: old 190.47 ms, current 2590.43 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2615.11 | 6 | as2.prenet.diode.io:41046 | seed | 179.06 | eu1.prenet.diode.io:41046 | 17.89 | 161.17 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 185.99 |
| cold | current | 5533.41 | 3 | eu1.prenet.diode.io:41046 | seed | 15.09 | eu1.prenet.diode.io:41046 | 15.09 | 0 | 2 | 2 | eu1.prenet.diode.io:41046 | seed | 3942.39 |
| warm-1 | old | 2304.45 | 6 | as2.prenet.diode.io:41046 | seed | 177.16 | eu1.prenet.diode.io:41046 | 10.46 | 166.7 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 194.88 |
| warm-1 | current | 6183.08 | 3 | eu1.prenet.diode.io:41046 | seed | 16.64 | eu1.prenet.diode.io:41046 | 16.64 | 0 | 2 | 2 | 144.126.157.138:41046 | target | 1922.83 |
| warm-2 | old | 4041.5 | 6 | as2.prenet.diode.io:41046 | seed | 186.34 | eu1.prenet.diode.io:41046 | 12.04 | 174.3 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 190.53 |
| warm-2 | current | 7046.2 | 3 | eu1.prenet.diode.io:41046 | seed | 12.15 | eu1.prenet.diode.io:41046 | 12.15 | 0 | 2 | 2 | 144.126.157.138:41046 | target | 1906.07 |
