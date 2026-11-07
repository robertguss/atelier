# Third-party notices

## T3 Code

Parts of this app's UI layer come from T3 Code
(https://github.com/pingdotgg/t3code, commit 6577c6b), used under the MIT
License below. Each file carries a header naming its source.

Copied unchanged apart from the header:

| File here                         | Source in T3 Code                                       |
| --------------------------------- | ------------------------------------------------------- |
| `src/components/ui/badge.tsx`     | `apps/web/src/components/ui/badge.tsx`                  |
| `src/components/ui/button.tsx`    | `apps/web/src/components/ui/button.tsx`                 |
| `src/components/ui/empty.tsx`     | `apps/web/src/components/ui/empty.tsx`                  |
| `src/components/ui/input.tsx`     | `apps/web/src/components/ui/input.tsx`                  |
| `src/components/ui/spinner.tsx`   | `apps/web/src/components/ui/spinner.tsx`                |
| `src/components/ui/switch.tsx`    | `apps/web/src/components/ui/switch.tsx`                 |
| `src/components/ui/textarea.tsx`  | `apps/web/src/components/ui/textarea.tsx`               |
| `src/lib/markdown-incremental.ts` | `apps/web/src/markdown-incremental.ts`                  |
| `src/lib/markdownStreamBlocks.ts` | `apps/web/src/components/chat/markdownStreamBlocks.ts`  |
| `src/lib/pendingUserInput.ts`     | `packages/client-runtime/src/state/pendingUserInput.ts` |
| `src/lib/visibleAnimation.ts`     | `apps/web/src/lib/visibleAnimation.ts`                  |

Adapted:

| File here                                        | Source in T3 Code                                  | Change                                                                                         |
| ------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/components/ui/sheet.tsx`                    | `apps/web/src/components/ui/sheet.tsx`             | The retained-popup helpers it imported from `dialog.tsx` are inlined                           |
| `src/components/ui/standalone-page.tsx`          | `apps/web/src/components/ui/standalone-page.tsx`   | Wordmark replaced with the Atelier name; description is a `div`                                |
| `src/lib/utils.ts`                               | `apps/web/src/lib/utils.ts`                        | Only `cn` kept                                                                                 |
| `src/index.css`                                  | `apps/web/src/index.css`                           | Theme tokens, layer order, the utilities used here and a trimmed set of `.chat-markdown` rules |
| `src/auth/ClerkShell.tsx` (appearance variables) | `apps/web/src/components/clerk/clerkAppearance.ts` | Colour variables only                                                                          |
| `components.json`                                | `apps/web/components.json`                         | Only the `@coss` registry kept                                                                 |

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
