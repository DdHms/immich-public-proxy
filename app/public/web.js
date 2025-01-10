class LGallery {
  items
  lightGallery
  element
  index = 0

  init (params = {}) {
    // Create the lightGallery instance
    this.element = document.getElementById('lightgallery')
    this.lightGallery = lightGallery(this.element, Object.assign({
      plugins: [lgZoom, lgThumbnail, lgVideo, lgFullscreen],
      speed: 500,
      /*
      This license key was graciously provided by LightGallery under their
      GPLv3 open-source project license:
      */
      licenseKey: '8FFA6495-676C4D30-8BFC54B6-4D0A6CEC'
      /*
      Please do not take it and use it for other projects, as it was provided
      specifically for Immich Public Proxy.

      For your own projects you can use the default license key of
      0000-0000-000-0000 as per their docs:

      https://www.lightgalleryjs.com/docs/settings/#licenseKey
      */
    }, params.lgConfig))
    this.items = params.items

    let timeout
    window.addEventListener('scroll', () => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(lgallery.handleScroll, 100)
    })
    lgallery.handleScroll()
  }

  handleScroll () {
    const rect = lgallery.element.getBoundingClientRect()
    const scrollPosition = Math.max(0, rect.bottom - window.innerHeight)
    const buffer = 200 // pixels before bottom to trigger load

    if (scrollPosition <= buffer) {
      lgallery.loadMoreItems()
    }
  }

  loadMoreItems () {
    const numberOfItems = 100
    if (this.index < this.items.length) {
      // Append thumbnails
      this.items
        .slice(this.index, this.index + numberOfItems)
        .forEach(item => {
          if (item.video) {
            this.element.insertAdjacentHTML('beforeend', `<a data-video='${item.video}'
        ${item.downloadUrl ? 'data-download-url="' + item.downloadUrl + '"' : ''}>
        <img alt="" src="${item.thumbnailUrl}"/><div class="play-icon"></div></a>`)
          } else {
            this.element.insertAdjacentHTML('beforeend', `<a href="${item.previewUrl}"
        ${item.downloadUrl ? 'data-download-url="' + item.downloadUrl + '"' : ''}>
        <img alt="" src="${item.thumbnailUrl}"/></a>`)
          }
        })
      this.lightGallery.refresh()
      this.index += numberOfItems
    }
  }
}
const lgallery = new LGallery()
