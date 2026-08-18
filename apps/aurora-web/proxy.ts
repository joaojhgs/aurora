import { NextResponse, type NextRequest } from 'next/server'
import {
  AURORA_DEBUG_UI_COOKIE_NAME,
  serializeAuroraDebugUiOverride,
} from './app/debug-ui-override'
import {
  debugUiOverrideJson,
  isAuroraDebugUiPickerEnabled,
  resolveAuroraDebugUiLaunch,
} from './app/debug-ui-launch'

export function proxy(request: NextRequest) {
  const nodeEnv = process.env.NODE_ENV ?? ''
  if (!isAuroraDebugUiPickerEnabled({ nodeEnv, env: process.env })) {
    if (request.nextUrl.pathname === '/__aurora/debug-preset') {
      return new NextResponse(null, { status: 404 })
    }
    return NextResponse.next()
  }

  const launch = resolveAuroraDebugUiLaunch({
    nodeEnv,
    env: process.env,
    search: request.nextUrl.searchParams,
    cookie: request.headers.get('cookie'),
  })

  if (request.nextUrl.pathname === '/__aurora/debug-preset') {
    return NextResponse.json(debugUiOverrideJson(launch), {
      headers: {
        'cache-control': 'no-store',
      },
    })
  }

  const response = NextResponse.next()
  if (launch) {
    response.cookies.set(AURORA_DEBUG_UI_COOKIE_NAME, serializeAuroraDebugUiOverride(launch.override), {
      path: '/',
      sameSite: 'lax',
    })
  }
  return response
}

export const config = {
  matcher: [
    '/__aurora/debug-preset',
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest).*)',
  ],
}
