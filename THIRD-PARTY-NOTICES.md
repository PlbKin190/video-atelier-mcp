# Third-party notices

What this project depends on, under which licence, and what that means for you. Every line below
was checked against the source named, on 18 September 2026 — not quoted from memory.

## What this repository itself is under

[PolyForm Noncommercial 1.0.0](LICENSE). Source-available, not OSI open source. Free for personal,
study, hobby and nonprofit use, including charities, schools, public research bodies and government;
commercial use needs a separate licence from the author.

**Nothing below forces that hand.** No dependency of this project is copyleft, and none requires
this code to be released under any particular licence.

## npm dependencies

| Package | Licence | Used for |
|---|---|---|
| `@modelcontextprotocol/sdk` | MIT | the MCP server itself |
| `zod` | MIT | input schemas for every tool |
| `fs-extra` | MIT | file helpers |
| `typescript` | Apache-2.0 | build only |
| `@types/node`, `@types/fs-extra` | MIT | build only |
| `svelte`, `vite`, `@sveltejs/vite-plugin-svelte` | MIT | the editor, build only |

Nothing ships to the runtime image but the compiled output and the production dependencies.

## ffmpeg — read this one

The Docker image installs Debian's `ffmpeg` package, which is **built with `--enable-gpl`**
(verify it yourself: `docker run --rm --entrypoint sh <image> -c 'ffmpeg -version'` and look at the
configuration line). That binary is therefore under the **GPL**.

Two things follow, and they are the reason this section exists:

1. **This project's own code is unaffected.** ffmpeg is invoked as a separate process, with an
   argument array, through `spawn` — never linked, never loaded in-process. That separation is what
   keeps the GPL off this code, and it is deliberate: see `src/tools/media.ts`, function `run`.
2. **This repository distributes no ffmpeg binary.** It ships a Dockerfile; the image is built on
   your machine and pulls ffmpeg from Debian. If you go on to *distribute the built image* to
   others, you are redistributing a GPL binary, and the GPL's terms apply to it — Debian publishes
   the corresponding sources. Building and running it for yourself raises no such question.

If you want to avoid GPL ffmpeg entirely, point `FFMPEG_PATH` and `FFPROBE_PATH` at an LGPL build of
your own; nothing in this project depends on a GPL-only feature.

## SAM2 (the `sam2` Docker profile only)

| What | Licence | Source checked |
|---|---|---|
| SAM 2 code | **Apache-2.0** | `facebookresearch/sam2`, `LICENSE` |
| `facebook/sam2-hiera-small` weights | **Apache-2.0** | Hugging Face model card metadata |

Both permissive, so the seven `sam2_*` tools raise no licensing obstacle to commercial use of this
project.

One honest caveat, unrelated to licensing: the pipeline these tools were ported from ran against a
**locally patched** build of `sam2`, whose provenance could not be established. `Dockerfile.sam2`
installs the official Meta package instead. That profile has never been built or run here — check
that the official package behaves as you need before relying on it.

## Fonts

The image installs `fonts-dejavu-core` (DejaVu fonts, a permissive Bitstream Vera-derived licence),
used by `captions_burn` and by the `drawtext` pass that renders text overlays.

## Content you make with this

Footage produced through the optional `azure-sora` backend is model-generated. Label it where your
audience or platform expects that, and follow the provider's own terms. This repository ships no
generated footage and no third-party media: the example rushes are synthesised by ffmpeg's own test
sources, so there is no licence to track.
