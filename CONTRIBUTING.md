# Contributing

Patches are welcome. Two things to know before you open one.

## What this project is licensed under

[PolyForm Noncommercial 1.0.0](LICENSE). You may use, fork, modify and redistribute this for any
noncommercial purpose — personal use, study, hobby projects, and use by charities, schools, public
research bodies and government. Commercial use is not granted by that licence and requires a
separate agreement with the author.

## The grant you make by contributing

**By opening a pull request, you grant Christian Verbrugge a perpetual, worldwide, non-exclusive,
irrevocable, royalty-free licence to use, reproduce, modify, distribute and sublicense your
contribution, under any licence terms, including commercial ones.**

You keep the copyright on what you wrote. You are not signing it away — you are giving permission
broad enough that your contribution can ship inside a commercial licence of this project.

This is not bureaucracy for its own sake. The project is offered free for noncommercial use and
paid for commercial use; that only works if every line in it can be licensed commercially. Without
this grant, a merged contribution would make the whole project unsellable, and the merge could not
happen.

You also confirm that the contribution is your own work, or that you have the right to submit it
under these terms — and that it carries no code you cannot license this way (no copy-pasted GPL,
no employer-owned code you lack permission for).

If you cannot make that grant, say so in the pull request. An issue describing the problem is
just as useful, and costs you nothing.

## Practical notes

- Run `npx tsc --noEmit` before opening a PR; it must be clean.
- Verify against the Docker image, not just your machine — the host ffmpeg and the one in the image
  differ in ways that matter (Homebrew's has no libass, so `captions_burn` fails there and works in
  the container).
- Tool descriptions are the interface an agent reads. Keep them in English, one sentence, and say
  what the tool actually does rather than what it is named after.
- State limitations in the README rather than leaving them to be discovered.
