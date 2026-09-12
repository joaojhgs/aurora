import { NextResponse, type NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const fetchCache = 'force-no-store'
export const revalidate = 0

const ALLOWED_PATH_PREFIX = '/k2-fsa/sherpa-onnx/releases/download/'
const ALLOWED_REDIRECT_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
])

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params
  let pathname: string
  try {
    pathname = `/${path.map((part) => decodeURIComponent(part)).join('/')}`
  } catch {
    return new NextResponse(null, { status: 404 })
  }
  if (!isAllowedReleasePath(pathname)) {
    return new NextResponse(null, { status: 404 })
  }

  const upstream = `https://github.com${pathname}${request.nextUrl.search}`
  let response: Response
  try {
    response = await fetch(upstream, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        accept: request.headers.get('accept') ?? '*/*',
        'user-agent': 'Aurora-hosted-voice-assets',
      },
    })
  } catch {
    return new NextResponse(null, { status: 502 })
  }

  if (!isAllowedFinalUrl(response.url)) {
    return new NextResponse(null, { status: 502 })
  }

  const headers = new Headers()
  const contentType = response.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)
  const contentLength = response.headers.get('content-length')
  if (contentLength) headers.set('content-length', contentLength)
  const contentDisposition = response.headers.get('content-disposition')
  if (contentDisposition) headers.set('content-disposition', contentDisposition)
  headers.set('cache-control', 'private, max-age=0')

  return new NextResponse(response.body, {
    status: response.status,
    headers,
  })
}

function isAllowedReleasePath(pathname: string): boolean {
  if (!pathname.startsWith(ALLOWED_PATH_PREFIX)) return false
  if (pathname.includes('//') || pathname.includes('\\')) return false
  const parts = pathname.split('/').filter((part) => part.length > 0)
  return parts.every((part) => part !== '.' && !part.includes('..'))
}

function isAllowedFinalUrl(url: string): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && ALLOWED_REDIRECT_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}
