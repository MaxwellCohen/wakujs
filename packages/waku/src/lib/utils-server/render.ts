import type { RenderHtml, RenderHtmlFallback, RenderRsc } from '../types.js';
import { ETAGS_ID } from '../utils-isomorphic/etags.js';
import { getDigestIfRenderCancellation } from '../utils-isomorphic/render-cancellation.js';
import { renderWithWeakPromises } from './weak-promise-stream.js';

const validateRscElementIds = (elements: Record<string, unknown>) => {
  for (const id of Object.keys(elements)) {
    if (id.startsWith('_')) {
      throw new Error(
        `RSC element IDs starting with "_" are reserved for Waku internals: ${id}`,
      );
    }
  }
};

export function createRenderUtils({
  temporaryReferences,
  renderToReadableStream,
  loadSsrEntryModule,
  buildId,
  createDebugChannel,
  debugId,
  onError: reportError,
}: {
  temporaryReferences: unknown;
  renderToReadableStream: (
    data: unknown,
    options?: object,
    extraOptions?: object,
  ) => ReadableStream;
  loadSsrEntryModule: () => Promise<
    typeof import('../vite-entries/entry.ssr.js')
  >;
  buildId: string;
  createDebugChannel?:
    | (() => {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      })
    | undefined;
  debugId?: string | undefined;
  onError: (e: unknown) => void;
}): {
  renderRsc: RenderRsc;
  renderHtml: RenderHtml;
  renderHtmlFallback: RenderHtmlFallback;
} {
  const onError = (error: unknown): string | undefined => {
    const digest = getDigestIfRenderCancellation(error);
    if (digest) {
      return digest;
    }
    reportError(error);
  };

  // The Flight tee and the signal that tells React when the HTML render that
  // reads it is done. React keeps the Flight bytes open until it settles.
  const htmlFirstByStream = new WeakMap<
    ReadableStream,
    { tee: unknown; resolve: () => void; reject: () => void }
  >();

  return {
    async renderRsc(elements, options) {
      validateRscElementIds(elements);
      const data: Record<string, unknown> = buildId
        ? { ...elements, _buildId: buildId }
        : { ...elements };
      if (options && 'value' in options) {
        data._value = options.value;
      }
      if (options?.etags && Object.keys(options.etags).length) {
        data[ETAGS_ID] = options.etags;
      }
      // enableFlightHTMLFirst: only the Flight render that feeds HTML SSR opts
      // in, with a tee that SSR reads. RSC-only responses (SPA nav) do not, so
      // they carry full content.
      const tee = options?.unstable_htmlFirst
        ? (await loadSsrEntryModule()).INTERNAL_createTee()
        : undefined;
      // HTML-first Flight keeps the byte stream open until this settles: it is
      // resolved when the HTML render finishes and rejected if it errored or
      // aborted, so React then writes the stubbed rows into the stream.
      let htmlFirstSignal:
        | { resolve: () => void; reject: () => void; promise: Promise<void> }
        | undefined;
      if (tee) {
        let resolve!: () => void;
        let reject!: () => void;
        const promise = new Promise<void>((res, rej) => {
          resolve = res;
          reject = () => rej(new Error('HTML render did not complete'));
        });
        // React attaches its own handlers; never leave a rejection unhandled.
        promise.catch(() => {});
        htmlFirstSignal = { resolve, reject, promise };
      }
      const stream = renderWithWeakPromises(data, (model) =>
        renderToReadableStream(
          model,
          {
            temporaryReferences,
            onError,
            debugChannel: createDebugChannel?.(),
            ...(tee && htmlFirstSignal
              ? { htmlFirst: htmlFirstSignal.promise, tee }
              : {}),
          },
          {
            onClientReference(metadata: {
              id: string;
              name: string;
              deps: { js: string[]; css: string[] };
            }) {
              options?.unstable_clientModuleCallback?.(metadata.deps.js);
            },
          },
        ),
      );
      if (tee && htmlFirstSignal) {
        htmlFirstByStream.set(stream, {
          tee,
          resolve: htmlFirstSignal.resolve,
          reject: htmlFirstSignal.reject,
        });
      }
      return stream;
    },
    async renderHtml(elementsStream, html, options) {
      const htmlFirst = htmlFirstByStream.get(elementsStream);
      let htmlResult;
      try {
        const { INTERNAL_renderHtmlStream: renderHtmlStream } =
          await loadSsrEntryModule();

        const rscHtmlStream = renderToReadableStream(html, { onError });
        htmlResult = await renderHtmlStream(elementsStream, rscHtmlStream, {
          tee: htmlFirst?.tee,
          htmlFirstSignal: htmlFirst,
          rscPath: options.rscPath,
          formState: options.formState as never,
          nonce: options.nonce,
          extraScriptContent: options.unstable_extraScriptContent,
          debugId,
          onError,
        });
      } catch (e) {
        // No HTML render will read the tee, so let the Flight stream finish.
        htmlFirst?.reject();
        throw e;
      }
      return new Response(htmlResult.stream, {
        status: htmlResult.status || options.status || 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
    async renderHtmlFallback(options) {
      const { INTERNAL_renderHtmlFallback: renderHtmlFallback } =
        await loadSsrEntryModule();
      const html = await renderHtmlFallback({
        nonce: options?.nonce,
        extraScriptContent: options?.unstable_extraScriptContent,
      });
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  };
}
