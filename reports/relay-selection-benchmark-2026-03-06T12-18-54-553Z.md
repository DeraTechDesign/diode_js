# Relay Selection Benchmark Report

- Generated: 2026-03-06T12:18:54.554Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Provider file: `C:\Users\4ever\Documents\GitHub\diode_js\reports\provider-candidates.json`
- Provider candidates loaded: 1

## Summary

- Average connect time: old 2402.58 ms, current 3888.56 ms
- Average selected relay RTT: old 173.09 ms, current 11.23 ms
- Average best connected RTT: old 13.54 ms, current 11.23 ms
- Average gap to best: old 159.55 ms, current 0 ms
- Average device resolution: old 182.87 ms, current 1301.68 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | --- | --- | ---: |
| cold | old | 3005.31 | 6 | as2.prenet.diode.io:41046 | seed | 166.23 | eu1.prenet.diode.io:41046 | 11.2 | 155.02 | us2.prenet.diode.io:41046 | seed | 189.77 |
| cold | current | 3520.47 | 4 | eu1.prenet.diode.io:41046 | seed | 10.62 | eu1.prenet.diode.io:41046 | 10.62 | 0 | 144.126.157.138:41046 | target | 1185.06 |
| warm-1 | old | 2209.78 | 6 | as2.prenet.diode.io:41046 | seed | 178.85 | eu1.prenet.diode.io:41046 | 13.11 | 165.75 | us2.prenet.diode.io:41046 | seed | 182.68 |
| warm-1 | current | 4366.4 | 4 | eu1.prenet.diode.io:41046 | seed | 10.87 | eu1.prenet.diode.io:41046 | 10.87 | 0 | 144.126.157.138:41046 | target | 1276.9 |
| warm-2 | old | 1992.66 | 6 | as2.prenet.diode.io:41046 | seed | 174.19 | eu1.prenet.diode.io:41046 | 16.31 | 157.88 | us2.prenet.diode.io:41046 | seed | 176.17 |
| warm-2 | current | 3778.81 | 4 | eu1.prenet.diode.io:41046 | seed | 12.21 | eu1.prenet.diode.io:41046 | 12.21 | 0 | 144.126.157.138:41046 | target | 1443.09 |
