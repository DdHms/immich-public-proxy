import immich from './immich'
import { Response } from 'express-serve-static-core'
import { Asset, AssetType, ImageSize, IncomingShareRequest, SharedLink } from './types'
import { canDownload, getConfigOption } from './functions'
import archiver from 'archiver'
import { respondToInvalidRequest } from './invalidRequestHandler'
import { sanitize } from './includes/sanitize'
import { Readable } from 'stream'

class Render {
  lgConfig

  constructor () {
    this.lgConfig = getConfigOption('lightGallery', {})
  }

  /**
   * Stream data from Immich back to the client
   */
  async assetBuffer (req: IncomingShareRequest, res: Response, asset: Asset, size?: ImageSize | string) {
    // Get meta info regarding the asset
    const metaRes = await fetch(immich.buildUrl(immich.apiUrl() + '/assets/' + encodeURIComponent(asset.id), {
      key: asset.key
    }))
    const meta = await metaRes.json()

    if (meta.isTrashed || meta.visibility === 'locked') {
      respondToInvalidRequest(res, 404, `Asset ${asset.id} is trashed or locked`)
      return
    }

    const headerList = ['content-type', 'content-length', 'last-modified', 'etag']
    size = immich.validateImageSize(size)
    let subpath, sizeQueryParam
    
    if (asset.type === AssetType.video) {
      /**
       * QUALITY OPTIMIZATION:
       * Checks the environment variable set in docker-compose.
       * Default is 'playback' (low quality/fast). Set to 'original' for high quality.
       */
      const qualitySetting = process.env.VIDEO_QUALITY?.toLowerCase() || 'playback'
      subpath = qualitySetting === 'original' ? '/original' : '/video/playback'
    } else if (asset.type === AssetType.image) {
      if (size === ImageSize.original && getConfigOption('ipp.downloadOriginalPhoto', true)) {
        subpath = '/original'
      } else if (size === ImageSize.preview || size === ImageSize.original) {
        subpath = '/thumbnail'
        sizeQueryParam = 'preview'
      } else {
        subpath = '/' + size
      }
    }
    
    const headers: Record<string, string> = {}

    if (asset.type === AssetType.video) {
      const rangeHeader = (req as any).headers?.range || req.range || ''
      const range = rangeHeader.replace(/bytes=/, '').split('-')
      const start = parseInt(range[0], 10) || 0
      
      // 10MB Chunks to reduce proxy handshake overhead
      const CHUNK_SIZE = 10 * 1024 * 1024 
      const end = range[1] ? parseInt(range[1], 10) : start + CHUNK_SIZE - 1
      
      headers.range = `bytes=${start}-${end}`
      headerList.push('cache-control', 'content-range')
      res.setHeader('accept-ranges', 'bytes')
    }

    const url = immich.buildUrl(immich.apiUrl() + '/assets/' + encodeURIComponent(asset.id) + subpath, {
      [asset.keyType || 'key']: asset.key,
      size: sizeQueryParam,
      password: asset.password
    })
    
    const data = await fetch(url, { headers })

    if (size === ImageSize.original && asset.originalFileName && getConfigOption('ipp.downloadOriginalPhoto', true)) {
      res.setHeader('Content-Disposition', `attachment; filename="${this.getFilename(asset)}"`)
    }

    if (data.status >= 200 && data.status < 300) {
      res.status(data.status)
      headerList.forEach(header => {
        const value = data.headers.get(header)
        if (value) res.setHeader(header, value)
      })

      if (data.body) {
        // High-performance native piping
        (Readable as any).fromWeb(data.body as any).pipe(res)
      } else {
        res.end()
      }
    } else {
      let immichMessage = ''
      try {
        const json = await data.json()
        if (json.message) immichMessage = '\nResponse from Immich: ' + json.message
      } catch (e) { }
      respondToInvalidRequest(res, 404, 'Failed response from Immich for asset ' + asset.id + ' on this URL:\n' + url + immichMessage)
    }
  }

  async gallery (res: Response, share: SharedLink, openItem?: number) {
    const publicBaseUrl = process.env.PUBLIC_BASE_URL || res.req.headers.publicBaseUrl || (res.req.protocol + '://' + res.req.headers.host)

    const items = await Promise.all(share.assets.map(async (asset) => {
      let video, downloadUrl
      if (asset.type === AssetType.video) {
        video = JSON.stringify({
          source: [
            {
              src: immich.videoUrl(share.key, asset.id),
              type: await immich.getVideoContentType(asset)
            }
          ],
          attributes: { playsinline: 'playsinline', controls: 'controls' }
        })
      }
      if (getConfigOption('ipp.downloadOriginalPhoto', true)) {
        downloadUrl = immich.photoUrl(share.key, asset.id, ImageSize.original)
      }

      const thumbnailUrl = immich.photoUrl(share.key, asset.id, ImageSize.thumbnail)
      const previewUrl = immich.photoUrl(share.key, asset.id, immich.getPreviewImageSize(asset))
      const description = getConfigOption('ipp.showMetadata.description', false) && typeof asset?.exifInfo?.description === 'string' ? asset.exifInfo.description.replace(/'/g, '&apos;') : ''

      const itemHtml = [
        video ? `<a data-video='${video}'` : `<a href="${previewUrl}"`,
        downloadUrl ? ` data-download-url="${downloadUrl}"` : '',
        description ? ` data-sub-html='<p>${description}</p>'` : '',
        ` data-download="${this.getFilename(asset)}"><img alt="" src="${thumbnailUrl}"/>`,
        video ? '<div class="play-icon"></div>' : '',
        '</a>'
      ].join('')

      return { html: itemHtml, thumbnailUrl, previewUrl }
    }))

    res.render('gallery', {
      items,
      openItem,
      title: this.title(share),
      publicBaseUrl,
      path: '/share/' + share.key,
      showDownload: canDownload(share),
      showTitle: getConfigOption('ipp.showGalleryTitle', false),
      lgConfig: getConfigOption('lightGallery', {})
    })
  }

  title (share: SharedLink) {
    return share.description || share?.album?.albumName || 'Gallery'
  }

  async downloadAll (res: Response, share: SharedLink) {
    res.setHeader('Content-Type', 'application/zip')
    let filename = (sanitize(this.title(share)) || 'photos') + '.zip'
    filename = encodeURI(filename)
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
    const archive = archiver('zip', { zlib: { level: 6 } })
    archive.pipe(res)
    for (const asset of share.assets) {
      const url = immich.buildUrl(immich.apiUrl() + '/assets/' + encodeURIComponent(asset.id) + '/original', {
        key: asset.key,
        password: asset.password
      })
      const data = await fetch(url)
      if (!data.ok) continue
      archive.append(Buffer.from(await data.arrayBuffer()), { name: this.getFilename(asset) })
    }
    await archive.finalize()
    archive.on('end', () => res.end())
  }

  getFilename (asset: Asset) {
    const extension = asset.originalFileName?.match(/(\.\w+)$/)?.[1] || ''
    switch (getConfigOption('ipp.downloadedFilename')) {
      case 1: return asset.id + extension
      case 2: return 'img_' + asset.id.slice(0, 8) + extension
      default: return asset.originalFileName || (asset.id + extension)
    }
  }
}

const render = new Render()
export default render
