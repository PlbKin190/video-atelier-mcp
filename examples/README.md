# Examples

## The footage

`make_sample_footage.sh` builds two four-second rushes with ffmpeg's own test sources
(`testsrc2` and `smptebars`) into `work/in/`.

They are synthesised rather than downloaded on purpose: a stock-footage URL rots, and its licence
has to be re-checked by every reader. ffmpeg's test sources are deterministic, need no network,
and raise no rights question — so this example runs identically anywhere, today and later.

```bash
sh examples/make_sample_footage.sh
```

Swap in your own footage whenever you like; nothing in the walkthrough depends on what the rushes
show.

## The walkthrough

[end_to_end.md](end_to_end.md) — twelve calls, from import to a captioned 16:9 master and a 9:16
export. It is a real transcript: the outputs shown are the ones the Docker image produced.
