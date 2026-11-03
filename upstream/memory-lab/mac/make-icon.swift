// Draws the 1024px app icon (a cube on a dark teal rounded square). Usage: swift make-icon.swift out.png
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
let inset: CGFloat = 100, rect = CGRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let bg = CGPath(roundedRect: rect, cornerWidth: 185, cornerHeight: 185, transform: nil)
ctx.addPath(bg); ctx.clip()
let colors = [CGColor(red: 0.10, green: 0.27, blue: 0.30, alpha: 1), CGColor(red: 0.04, green: 0.12, blue: 0.14, alpha: 1)] as CFArray
ctx.drawLinearGradient(CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!, start: CGPoint(x: 0, y: size), end: CGPoint(x: 0, y: 0), options: [])
// Isometric cube: three faces with slightly different tints, then outlines.
let c = CGPoint(x: size / 2, y: size / 2 - 10), r: CGFloat = 250
let top = CGPoint(x: c.x, y: c.y + r), ul = CGPoint(x: c.x - r * 0.866, y: c.y + r / 2), ur = CGPoint(x: c.x + r * 0.866, y: c.y + r / 2)
let ll = CGPoint(x: c.x - r * 0.866, y: c.y - r / 2), lr = CGPoint(x: c.x + r * 0.866, y: c.y - r / 2), bottom = CGPoint(x: c.x, y: c.y - r)
func face(_ pts: [CGPoint], _ white: CGFloat, _ alpha: CGFloat) { ctx.beginPath(); ctx.addLines(between: pts); ctx.closePath(); ctx.setFillColor(CGColor(gray: white, alpha: alpha)); ctx.fillPath() }
face([top, ur, c, ul], 1, 0.95)
face([ul, c, bottom, ll], 1, 0.55)
face([c, ur, lr, bottom], 1, 0.75)
ctx.setStrokeColor(CGColor(red: 0.12, green: 0.14, blue: 0.2, alpha: 1)); ctx.setLineWidth(18); ctx.setLineJoin(.round)
ctx.beginPath(); ctx.addLines(between: [top, ur, lr, bottom, ll, ul, top]); ctx.strokePath()
ctx.beginPath(); ctx.addLines(between: [ul, c, ur]); ctx.move(to: c); ctx.addLine(to: bottom); ctx.strokePath()
image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
