# Relay Selection Benchmark Report

- Generated: 2026-03-06T13:10:49.432Z
- Baseline old manager source: `HEAD` commit `a2a3ee05661e5e838a3d8db865f6f0c84e762f92`
- Candidate manager source: current working tree `clientManager.js`
- Relay pool: default pre-net seeds
- Device lookup samples: 0x4632c04cf8c44a586554951e7de03ca2bd3e8f1c, 0xca1e71d8105a598810578fb6042fa8cbc1e7f039, 0x5365baf29cb7ab58de588dfc448913cb609283e2
- Network discovery mode: snapshot
- Benchmark profile: startup discovery only; background discovery probing disabled for deterministic timing
- Network discovery snapshot: `C:\Users\4ever\Documents\GitHub\diode_js\reports\dio-network-snapshot.json`

## Summary

- Average connect time: old 2062.67 ms, current 4818.23 ms
- Average selected relay RTT: old 176.4 ms, current 11.21 ms
- Average best connected RTT: old 13.6 ms, current 11.21 ms
- Average gap to best: old 162.79 ms, current 0 ms
- Average device resolution: old 179.34 ms, current 31.95 ms

| Phase | Version | Connect ms | Startup relays | Selected relay | Source | Selected RTT ms | Best relay | Best RTT ms | Gap ms | Discovery usable | Discovery startup | Device relay | Device source | Device resolution ms |
| --- | --- | ---: | ---: | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | --- | ---: |
| cold | old | 2320.16 | 6 | as2.prenet.diode.io:41046 | seed | 176.05 | eu1.prenet.diode.io:41046 | 13.57 | 162.48 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 179.01 |
| cold | current | 4561.94 | 3 | eu1.prenet.diode.io:41046 | seed | 12.55 | eu1.prenet.diode.io:41046 | 12.55 | 0 | 2 | 2 | us2.prenet.diode.io:41046 | seed | 36.82 |
| warm-1 | old | 1931.85 | 6 | as2.prenet.diode.io:41046 | seed | 172.82 | eu1.prenet.diode.io:41046 | 15.07 | 157.75 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 173.7 |
| warm-1 | current | 4985.8 | 3 | eu1.prenet.diode.io:41046 | seed | 11.52 | eu1.prenet.diode.io:41046 | 11.52 | 0 | 2 | 2 | us2.prenet.diode.io:41046 | seed | 32.63 |
| warm-2 | old | 1936.01 | 6 | as2.prenet.diode.io:41046 | seed | 180.32 | eu1.prenet.diode.io:41046 | 12.16 | 168.16 | n/a | n/a | us2.prenet.diode.io:41046 | seed | 185.3 |
| warm-2 | current | 4906.93 | 3 | eu1.prenet.diode.io:41046 | seed | 9.56 | eu1.prenet.diode.io:41046 | 9.56 | 0 | 2 | 2 | us2.prenet.diode.io:41046 | seed | 26.41 |
