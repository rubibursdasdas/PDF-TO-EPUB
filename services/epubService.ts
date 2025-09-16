// Helper to create META-INF/container.xml
const createContainerXml = () => `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

// Helper to create OEBPS/content.opf
const createContentOpf = (title: string, fileManifest: string) => `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="pub-id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${title}</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    ${fileManifest}
  </manifest>
  <spine toc="ncx">
    <itemref idref="content"/>
  </spine>
</package>`;

// Helper to create OEBPS/toc.ncx
const createTocNcx = (title: string, navPoints: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content=""/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>${title}</text>
  </docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`;

// Helper to create OEBPS/style.css
const createCss = () => `body {
  font-family: serif;
  line-height: 1.6;
  padding: 1em;
}
h1, h2, h3, h4, h5, h6 {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  line-height: 1.2;
}
img {
  max-width: 100%;
  display: block;
  margin: 1em auto;
}
nav ol {
  list-style-type: none;
  padding-left: 0;
}
nav li {
  margin-bottom: 0.5em;
}`;

// Main function
export const generateEpub = async (htmlContent: string, title: string): Promise<Blob> => {
  const jszip = new (window as any).JSZip();
  
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');
  const bookTitle = doc.querySelector('title')?.textContent || title;

  // 1. Mimetype file
  jszip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  
  // 2. Container file
  jszip.file('META-INF/container.xml', createContainerXml());
  
  const oebps = jszip.folder('OEBPS');
  if (!oebps) throw new Error("Could not create OEBPS folder.");

  const imagesFolder = oebps.folder('images');
  if (!imagesFolder) throw new Error("Could not create images folder.");

  // 3. Process images
  const images = doc.querySelectorAll('img');
  let imageCounter = 0;
  const imageManifestItems: string[] = [];

  for (const img of images) {
    const src = img.getAttribute('src');
    if (src && src.startsWith('data:')) {
      const [header, base64Data] = src.split(',');
      const mimeMatch = header.match(/:(.*?);/);
      if (mimeMatch && base64Data) {
        const mimeType = mimeMatch[1];
        const extension = mimeType.split('/')[1] || 'jpeg';
        const filename = `image${imageCounter}.${extension}`;
        
        imagesFolder.file(filename, base64Data, { base64: true });
        img.setAttribute('src', `images/${filename}`);
        imageManifestItems.push(`<item id="img${imageCounter}" href="images/${filename}" media-type="${mimeType}"/>`);
        imageCounter++;
      }
    }
  }

  // 4. Create CSS
  oebps.file('style.css', createCss());
  
  let head = doc.querySelector('head');
  if (head) {
    const link = doc.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('type', 'text/css');
    link.setAttribute('href', 'style.css');
    head.appendChild(link);
  }

  // 5. Create TOC.ncx
  const navPoints: string[] = [];
  const tocLinks = doc.querySelectorAll('nav ol li a');
  tocLinks.forEach((link, index) => {
    const text = link.textContent || '';
    const href = link.getAttribute('href') || '';
    navPoints.push(`<navPoint id="navpoint-${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${text}</text></navLabel>
      <content src="content.xhtml${href}"/>
    </navPoint>`);
  });
  const tocNcxContent = createTocNcx(bookTitle, navPoints.join('\n'));
  oebps.file('toc.ncx', tocNcxContent);

  // 6. Add the (modified) HTML content file as XHTML
  const serializer = new XMLSerializer();
  const docString = serializer.serializeToString(doc);
  const finalHtmlString = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
${doc.documentElement.innerHTML}
</html>`;
  
  oebps.file('content.xhtml', finalHtmlString);

  // 7. Create content.opf
  const contentOpfContent = createContentOpf(bookTitle, imageManifestItems.join('\n'));
  oebps.file('content.opf', contentOpfContent);

  // 8. Generate the EPUB blob
  return jszip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
  });
};