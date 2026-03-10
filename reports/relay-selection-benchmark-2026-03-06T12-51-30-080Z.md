# Relay Selection Benchmark Report

- Generated: 2026-03-06T12:51:30.080Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: disabled

## Summary

- Average connect time: old 2593.77 ms, current 4279.69 ms
- Average selected relay RTT: old 201.91 ms, current 17.48 ms
- Average best connected RTT: old 13.9 ms, current 17.48 ms
- Average gap to best: old 188.01 ms, current 0 ms
- Average device resolution: old 204.82 ms, current 646.7 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2806.94 | 6 | as2.prenet.diode.io:41046 | seed | 168.97 | eu1.prenet.diode.io:41046 | 14.29 | 154.68 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 173.91 |
| cold | current | 3395.14 | 3 | eu1.prenet.diode.io:41046 | seed | 11.09 | eu1.prenet.diode.io:41046 | 11.09 | 0 | 0 | 0 | 144.126.157.138:41046 | target | 1872.48 |
| warm-1 | old | 2845.47 | 6 | as2.prenet.diode.io:41046 | seed | 172.11 | eu1.prenet.diode.io:41046 | 14.72 | 157.39 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 176.44 |
| warm-1 | current | 4788.26 | 4 | eu1.prenet.diode.io:41046 | seed | 29.72 | eu1.prenet.diode.io:41046 | 29.72 | 0 | 0 | 0 | 144.126.157.138:41046 | target | 32.9 |
| warm-2 | old | 2128.91 | 6 | as2.prenet.diode.io:41046 | seed | 264.64 | eu1.prenet.diode.io:41046 | 12.7 | 251.95 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 264.12 |
| warm-2 | current | 4655.65 | 4 | eu1.prenet.diode.io:41046 | seed | 11.64 | eu1.prenet.diode.io:41046 | 11.64 | 0 | 0 | 0 | 144.126.157.138:41046 | target | 34.71 |
