# Change Log

## 0.1.8

- Report errors returned by the SaMo API with the service-provided detail instead of labeling them as incomplete streams.
- Honor requests for detailed, step-by-step guides with file paths and code snippets.

## 0.1.7

- Render formatted Markdown in chat responses and add copy buttons to fenced code blocks.

## 0.1.6

- Remove the obsolete editor-context error from saved conversations.
- Make the response inactivity timeout configurable from 15 to 300 seconds (120 seconds by default).
- Clarify timeout errors with likely causes and retry guidance.

## 0.1.3

- Add optional editor context to chat requests, using the active selection or file with a 12,000-character limit.

## 0.1.1

- Show clear errors when SaMo requests fail or time out, and identify older empty replies.

## 0.1.0

- Initial release: chat view for SaMo backed by the deployed SaMo HTTP API.
