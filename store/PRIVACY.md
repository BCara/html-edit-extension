# VibeRevise — privacy policy

*Last updated 4 October 2026.*

VibeRevise is a browser extension and web app for fixing the words in an HTML
document without disturbing its markup. This policy says what it does with
your information. The short version: almost nothing, and nothing leaves your
browser unless you turn on AI with your own key. Even then, it only goes to
the AI service you chose, and only when you ask.

## What stays in your browser

- **Your documents.** VibeRevise reads the document you open and edits it in
  your browser. It never uploads it anywhere of ours — there is nowhere of ours.
  Saving writes the file back to your computer, or to the server the document
  came from if that server accepts it.
- **Your name**, if you type one. It is stored in your browser and written into
  the comments you add to documents you save. It is self-declared, not a
  sign-in.
- **Whether comments are shown in the document.** A single on-or-off setting.
- **Your AI settings**, if you add them: the provider, its address, the model
  and your API key. They are kept in this browser only and are not synced. In
  the extension they are read only by VibeRevise's own settings page and
  background worker, never by the pages you edit.

Clear any of these from VibeRevise's settings, or by removing the extension.

## What leaves your browser

Nothing, except in two cases you choose yourself:

- **Saving to your own server.** If the document you are editing was served
  over your own network, saving sends it back to that same server, because
  that is where the file lives.
- **AI suggestions, if you add an API key.** AI is off until you add a key for
  a service you choose: Anthropic, OpenAI, OpenRouter, Google Gemini, or any
  compatible address, including a model on your own computer. When you press a
  button asking for a suggestion, VibeRevise sends that service the words of
  the paragraphs involved. A rewrite also sends a little of the text either
  side for context, and asking about a comment thread also sends the thread.
  It never sends the whole file or its markup. The request goes from your
  browser straight to the service, with your key; it does not pass through
  anything of ours. What that service does with it is governed by your
  agreement with them. A model on your own computer keeps it on your machine.

Nothing is sent anywhere else: no analytics, no crash reports, no tracking, no
advertising, no account, and no AI service of ours.

## What we never do

We do not collect, sell, share or use your data. We do not run servers that
receive it. We do not use it to determine creditworthiness or for any purpose
other than the feature you invoked.

## Contact

Questions: [your contact email — use a personal or product address, not a work one]
