import { type ReactNode, use } from 'react';
import {
  createFromReadableStream as createFromReadableStreamBase,
  createServerConsumerManifest,
  getClientEntryUrl,
} from '@vitejs/plugin-rsc/ssr';
import {
  createFromTee,
  createTee,
} from '@vitejs/plugin-rsc/vendor/react-server-dom/client.edge';
import type { ReactFormState } from 'react-dom/client';
import { renderToReadableStream } from 'react-dom/server.edge';
import { injectRSCPayload } from 'rsc-html-stream/server';
import htmlShell from 'virtual:vite-rsc-waku/html-shell';
import htmlTransform from 'virtual:vite-rsc-waku/html-transform';
// Layering rule: src/lib must not import src modules outside src/lib.
// Exception: SSR must share Minimal's slot context.
import { INTERNAL_ServerRoot } from '../../minimal/client-runtime.js';
import { hasRenderCancellationDigest } from '../utils-isomorphic/render-cancellation.js';
import { batchReadableStream } from '../utils-isomorphic/stream.js';
import {
  createBootstrapScriptContent,
  createHtmlFallback,
  getBootstrapPreamble,
} from '../utils-server/ssr.js';

const createFromReadableStream = <T,>(
  stream: ReadableStream<Uint8Array>,
): Promise<T> => {
  // DEV: hold the stream ~5s so React's late debug-channel chunks settle before close. https://github.com/wakujs/waku/pull/2154
  return createFromReadableStreamBase<T>(
    import.meta.env.DEV
      ? stream.pipeThrough(
          new TransformStream({
            flush: () => new Promise((r) => setTimeout(r, 5000)),
          }),
        )
      : stream,
  );
};

// enableFlightHTMLFirst: the tee is created before the Flight render so the
// server can hand it the real rows while the stream carries the stubbed ones.
export const createHtmlFirstTee = (): unknown =>
  createTee(createServerConsumerManifest());

type RenderHtmlStream = (
  rscStream: ReadableStream<Uint8Array>,
  rscHtmlStream: ReadableStream<Uint8Array>,
  options: {
    rscPath: string | undefined;
    formState: ReactFormState | undefined;
    nonce: string | undefined;
    extraScriptContent: string | undefined;
    debugId: string | undefined;
    onError: (e: unknown) => string | undefined;
    tee?: unknown;
  },
) => Promise<{ stream: ReadableStream; status: number | undefined }>;

type RscElementsPayload = Record<string, unknown>;
type RscHtmlPayload = ReactNode;

// This code runs on `ssr` environment,
// i.e. it runs on server but without `react-server` condition.
// These utilities are used by `rsc` environment through
// `import.meta.viteRsc.loadModule` API.

export const renderHtmlStream: RenderHtmlStream = async (
  rscStream,
  rscHtmlStream,
  options,
) => {
  // With a tee, SSR reads values from it and only the inlined bytes use the stream.
  const [stream1, stream2] = options.tee
    ? [undefined, rscStream]
    : rscStream.tee();

  let elementsPromise: Promise<RscElementsPayload>;
  let htmlPromise: Promise<RscHtmlPayload>;

  // deserialize RSC stream back to React VDOM
  const SsrRoot = () => {
    // RSC stream needs to be deserialized inside SSR component.
    // This is for ReactDomServer preinit/preload (e.g. client reference modulepreload, css)
    // https://github.com/facebook/react/pull/31799#discussion_r1886166075
    // FIXME unlike the client, this does not adopt the payload, so it keeps
    // its reserved keys and unstable_isImmutableElement reads no etags from it
    elementsPromise ??= options.tee
      ? (createFromTee(options.tee) as Promise<RscElementsPayload>)
      : createFromReadableStream<RscElementsPayload>(stream1!);
    htmlPromise ??= createFromReadableStream<RscHtmlPayload>(rscHtmlStream);
    return (
      <INTERNAL_ServerRoot elementsPromise={elementsPromise}>
        {use(htmlPromise)}
      </INTERNAL_ServerRoot>
    );
  };

  // render html
  const bootstrapScriptContent =
    createBootstrapScriptContent(getClientEntryUrl());
  let htmlStream: Awaited<ReturnType<typeof renderToReadableStream>>;
  let status: number | undefined;
  try {
    htmlStream = await renderToReadableStream(<SsrRoot />, {
      bootstrapScriptContent:
        getBootstrapPreamble({
          hydrate: true,
          initialRsc: true,
          debugId: options.debugId,
        }) +
        bootstrapScriptContent +
        (options.extraScriptContent || ''),
      onError: options.onError,
      ...(options.nonce ? { nonce: options.nonce } : {}),
      ...(options.formState ? { formState: options.formState } : {}),
    });
  } catch (e) {
    status = hasRenderCancellationDigest(e) ? undefined : 500;
    // SSR empty html and go full CSR on browser, which can revive RSC errors.
    const ssrErrorRoot = (
      <html>
        <body></body>
      </html>
    );
    htmlStream = await renderToReadableStream(ssrErrorRoot, {
      bootstrapScriptContent:
        getBootstrapPreamble({
          hydrate: false,
          initialRsc: true,
          debugId: options.debugId,
        }) +
        bootstrapScriptContent +
        (options.extraScriptContent || ''),
      ...(options.nonce ? { nonce: options.nonce } : {}),
    });
  }
  let responseStream: ReadableStream<Uint8Array> = htmlStream.pipeThrough(
    injectRSCPayload(
      batchReadableStream(stream2),
      options.nonce ? { nonce: options.nonce } : {},
    ),
  );
  if (htmlTransform) {
    responseStream = responseStream.pipeThrough(htmlTransform());
  }

  return { stream: responseStream, status };
};

export async function renderHtmlFallback(
  options?: Parameters<typeof createHtmlFallback>[2],
) {
  return createHtmlFallback(htmlShell, getClientEntryUrl(), options);
}
