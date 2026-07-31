import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const DEFAULT_CROP = Object.freeze({
  topRatio: 0.12,
  rightRatio: 0.03,
  bottomRatio: 0.05,
  leftRatio: 0.03,
})
const DEFAULT_THRESHOLDS = Object.freeze({
  minimumWidth: 300,
  minimumHeight: 500,
  minimumOpaqueRatio: 0.95,
  minimumLuminanceRange: 24,
  minimumLuminanceStandardDeviation: 2,
  minimumContrastPixelRatio: 0.003,
  minimumDistinctColorBuckets: 6,
  minimumEdgeContrastRatio: 0.0005,
})

export function analyzeIosScreenshot(path, options = {}) {
  const decoded = decodePng(readFileSync(path))
  const crop = normalizeCrop(decoded.width, decoded.height, options.crop)
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(options.thresholds ?? {}),
  }
  const metrics = measureVisibleContent(decoded, crop)
  const failures = []

  if (decoded.width < thresholds.minimumWidth) {
    failures.push(
      `width ${decoded.width} is below ${thresholds.minimumWidth}`,
    )
  }
  if (decoded.height < thresholds.minimumHeight) {
    failures.push(
      `height ${decoded.height} is below ${thresholds.minimumHeight}`,
    )
  }
  if (metrics.opaqueRatio < thresholds.minimumOpaqueRatio) {
    failures.push(
      `opaque ratio ${formatRatio(metrics.opaqueRatio)} is below ${formatRatio(
        thresholds.minimumOpaqueRatio,
      )}`,
    )
  }
  if (metrics.luminanceRange < thresholds.minimumLuminanceRange) {
    failures.push(
      `luminance range ${metrics.luminanceRange.toFixed(2)} is below ${thresholds.minimumLuminanceRange}`,
    )
  }
  if (
    metrics.luminanceStandardDeviation <
    thresholds.minimumLuminanceStandardDeviation
  ) {
    failures.push(
      `luminance deviation ${metrics.luminanceStandardDeviation.toFixed(2)} is below ${thresholds.minimumLuminanceStandardDeviation}`,
    )
  }
  if (metrics.contrastPixelRatio < thresholds.minimumContrastPixelRatio) {
    failures.push(
      `contrast pixel ratio ${formatRatio(metrics.contrastPixelRatio)} is below ${formatRatio(
        thresholds.minimumContrastPixelRatio,
      )}`,
    )
  }
  if (
    metrics.distinctColorBucketCount <
    thresholds.minimumDistinctColorBuckets
  ) {
    failures.push(
      `distinct color buckets ${metrics.distinctColorBucketCount} is below ${thresholds.minimumDistinctColorBuckets}`,
    )
  }
  if (metrics.edgeContrastRatio < thresholds.minimumEdgeContrastRatio) {
    failures.push(
      `edge contrast ratio ${formatRatio(metrics.edgeContrastRatio)} is below ${formatRatio(
        thresholds.minimumEdgeContrastRatio,
      )}`,
    )
  }

  return {
    schema: 'aurora.ios-screenshot-evidence.v1',
    status: failures.length === 0 ? 'passed' : 'failed',
    width: decoded.width,
    height: decoded.height,
    colorType: decoded.colorType,
    crop,
    thresholds,
    ...metrics,
    failures,
    secretsRedacted: true,
  }
}

export function assertIosScreenshotVisible(evidence, label = 'iOS screenshot') {
  if (evidence.status === 'passed') return
  throw new Error(
    `${label} did not show meaningful rendered UI: ${evidence.failures.join('; ')}`,
  )
}

function decodePng(buffer) {
  if (
    buffer.length < PNG_SIGNATURE.length ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error('iOS simulator screenshot is not a valid PNG')
  }

  let offset = PNG_SIGNATURE.length
  let header = null
  const compressedParts = []
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) {
      throw new Error(`PNG ${type} chunk exceeds the screenshot length`)
    }
    const data = buffer.subarray(dataStart, dataEnd)
    if (type === 'IHDR') header = parseHeader(data)
    else if (type === 'IDAT') compressedParts.push(data)
    else if (type === 'IEND') break
    offset = dataEnd + 4
  }

  if (!header) throw new Error('PNG screenshot has no IHDR chunk')
  if (compressedParts.length === 0) {
    throw new Error('PNG screenshot has no IDAT image data')
  }
  const bytesPerPixel = bytesPerPixelFor(header.colorType)
  const rowLength = header.width * bytesPerPixel
  const inflated = inflateSync(Buffer.concat(compressedParts))
  const expectedLength = header.height * (rowLength + 1)
  if (inflated.length !== expectedLength) {
    throw new Error(
      `PNG screenshot decoded to ${inflated.length} bytes; expected ${expectedLength}`,
    )
  }

  const pixels = Buffer.alloc(header.height * rowLength)
  let sourceOffset = 0
  for (let y = 0; y < header.height; y += 1) {
    const filter = inflated[sourceOffset]
    sourceOffset += 1
    const source = inflated.subarray(sourceOffset, sourceOffset + rowLength)
    const targetOffset = y * rowLength
    unfilterRow(
      filter,
      source,
      pixels,
      targetOffset,
      rowLength,
      bytesPerPixel,
    )
    sourceOffset += rowLength
  }

  return {
    ...header,
    bytesPerPixel,
    pixels,
  }
}

function parseHeader(data) {
  if (data.length !== 13) throw new Error('PNG IHDR chunk has an invalid length')
  const width = data.readUInt32BE(0)
  const height = data.readUInt32BE(4)
  const bitDepth = data[8]
  const colorType = data[9]
  const compression = data[10]
  const filter = data[11]
  const interlace = data[12]
  if (width === 0 || height === 0) {
    throw new Error('PNG screenshot has an empty image size')
  }
  if (bitDepth !== 8) {
    throw new Error(`PNG screenshot bit depth ${bitDepth} is not supported`)
  }
  if (compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new Error(
      'PNG screenshot uses unsupported compression, filtering, or interlacing',
    )
  }
  bytesPerPixelFor(colorType)
  return { width, height, bitDepth, colorType }
}

function bytesPerPixelFor(colorType) {
  if (colorType === 0) return 1
  if (colorType === 2) return 3
  if (colorType === 4) return 2
  if (colorType === 6) return 4
  throw new Error(`PNG screenshot color type ${colorType} is not supported`)
}

function unfilterRow(
  filter,
  source,
  target,
  targetOffset,
  rowLength,
  bytesPerPixel,
) {
  const previousOffset = targetOffset - rowLength
  for (let x = 0; x < rowLength; x += 1) {
    const left = x >= bytesPerPixel ? target[targetOffset + x - bytesPerPixel] : 0
    const up = previousOffset >= 0 ? target[previousOffset + x] : 0
    const upLeft =
      previousOffset >= 0 && x >= bytesPerPixel
        ? target[previousOffset + x - bytesPerPixel]
        : 0
    let predictor = 0
    if (filter === 1) predictor = left
    else if (filter === 2) predictor = up
    else if (filter === 3) predictor = Math.floor((left + up) / 2)
    else if (filter === 4) predictor = paeth(left, up, upLeft)
    else if (filter !== 0) throw new Error(`PNG screenshot uses filter ${filter}`)
    target[targetOffset + x] = (source[x] + predictor) & 0xff
  }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const diagonalDistance = Math.abs(estimate - upLeft)
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left
  if (upDistance <= diagonalDistance) return up
  return upLeft
}

function normalizeCrop(width, height, configured = {}) {
  const ratios = { ...DEFAULT_CROP, ...configured }
  for (const [name, ratio] of Object.entries(ratios)) {
    if (!Number.isFinite(ratio) || ratio < 0 || ratio >= 0.5) {
      throw new Error(`Screenshot crop ${name} must be between 0 and 0.5`)
    }
  }
  const left = Math.floor(width * ratios.leftRatio)
  const top = Math.floor(height * ratios.topRatio)
  const right = Math.ceil(width * (1 - ratios.rightRatio))
  const bottom = Math.ceil(height * (1 - ratios.bottomRatio))
  if (right <= left || bottom <= top) {
    throw new Error('Screenshot crop removed the entire image')
  }
  return {
    ...ratios,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

function measureVisibleContent(image, crop) {
  const targetSamples = 250_000
  const step = Math.max(
    1,
    Math.floor(Math.sqrt((crop.width * crop.height) / targetSamples)),
  )
  const samples = []
  const histogram = new Map()
  let opaqueCount = 0
  let luminanceSum = 0
  let luminanceSquaredSum = 0
  let minimumLuminance = 255
  let maximumLuminance = 0
  let edgeCount = 0
  let comparedEdgeCount = 0
  const previousRow = []

  for (let y = crop.top, row = 0; y < crop.bottom; y += step, row += 1) {
    let previous = null
    let column = 0
    for (let x = crop.left; x < crop.right; x += step, column += 1) {
      const pixel = readPixel(image, x, y)
      const luminance = relativeLuminance(pixel)
      samples.push({ ...pixel, luminance })
      if (pixel.a >= 245) opaqueCount += 1
      luminanceSum += luminance
      luminanceSquaredSum += luminance * luminance
      minimumLuminance = Math.min(minimumLuminance, luminance)
      maximumLuminance = Math.max(maximumLuminance, luminance)
      const bucket = `${pixel.r >> 4}:${pixel.g >> 4}:${pixel.b >> 4}`
      histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1)

      if (previous) {
        comparedEdgeCount += 1
        if (pixelDistance(pixel, previous) >= 28) edgeCount += 1
      }
      const above = previousRow[column]
      if (above) {
        comparedEdgeCount += 1
        if (pixelDistance(pixel, above) >= 28) edgeCount += 1
      }
      previous = pixel
      previousRow[column] = pixel
    }
  }

  if (samples.length === 0) throw new Error('Screenshot crop produced no samples')
  let dominantBucket = ''
  let dominantCount = 0
  for (const [bucket, count] of histogram) {
    if (count > dominantCount) {
      dominantBucket = bucket
      dominantCount = count
    }
  }
  const dominantParts = dominantBucket.split(':').map(Number)
  const dominantColor = {
    r: dominantParts[0] * 16 + 8,
    g: dominantParts[1] * 16 + 8,
    b: dominantParts[2] * 16 + 8,
    a: 255,
  }
  const minimumBucketSize = Math.max(2, Math.floor(samples.length * 0.00002))
  const distinctColorBucketCount = Array.from(histogram.values()).filter(
    (count) => count >= minimumBucketSize,
  ).length
  const contrastPixelCount = samples.filter(
    (pixel) => pixelDistance(pixel, dominantColor) >= 28,
  ).length
  const meanLuminance = luminanceSum / samples.length
  const variance = Math.max(
    0,
    luminanceSquaredSum / samples.length - meanLuminance * meanLuminance,
  )

  return {
    sampleStep: step,
    sampledPixelCount: samples.length,
    opaqueRatio: opaqueCount / samples.length,
    minimumLuminance: round(minimumLuminance),
    maximumLuminance: round(maximumLuminance),
    luminanceRange: round(maximumLuminance - minimumLuminance),
    meanLuminance: round(meanLuminance),
    luminanceStandardDeviation: round(Math.sqrt(variance)),
    dominantColor: {
      r: dominantColor.r,
      g: dominantColor.g,
      b: dominantColor.b,
      sampleRatio: round(dominantCount / samples.length, 6),
    },
    contrastPixelRatio: round(contrastPixelCount / samples.length, 6),
    distinctColorBucketCount,
    edgeContrastRatio: round(
      comparedEdgeCount === 0 ? 0 : edgeCount / comparedEdgeCount,
      6,
    ),
  }
}

function readPixel(image, x, y) {
  const offset = (y * image.width + x) * image.bytesPerPixel
  if (image.colorType === 0) {
    const value = image.pixels[offset]
    return { r: value, g: value, b: value, a: 255 }
  }
  if (image.colorType === 2) {
    return {
      r: image.pixels[offset],
      g: image.pixels[offset + 1],
      b: image.pixels[offset + 2],
      a: 255,
    }
  }
  if (image.colorType === 4) {
    const value = image.pixels[offset]
    return {
      r: value,
      g: value,
      b: value,
      a: image.pixels[offset + 1],
    }
  }
  return {
    r: image.pixels[offset],
    g: image.pixels[offset + 1],
    b: image.pixels[offset + 2],
    a: image.pixels[offset + 3],
  }
}

function relativeLuminance(pixel) {
  return 0.2126 * pixel.r + 0.7152 * pixel.g + 0.0722 * pixel.b
}

function pixelDistance(left, right) {
  return Math.max(
    Math.abs(left.r - right.r),
    Math.abs(left.g - right.g),
    Math.abs(left.b - right.b),
  )
}

function round(value, digits = 3) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function formatRatio(value) {
  return `${(value * 100).toFixed(3)}%`
}
