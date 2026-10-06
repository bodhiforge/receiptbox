import Foundation
import AppKit
import PDFKit

// A disposable display derivative; never write to the source URL.
let args=CommandLine.arguments
guard args.count == 5, let index=Int(args[4]), index >= 0 else { fatalError("Expected input, mime, output and page") }
let input=URL(fileURLWithPath:args[1]), output=URL(fileURLWithPath:args[3])
var count=1
let source:NSImage
if args[2] == "application/pdf" {
    guard let doc=PDFDocument(url:input), !doc.isLocked, doc.pageCount>0, index<doc.pageCount, let page=doc.page(at:index) else {fatalError("Unreadable PDF page")}
    count=doc.pageCount
    let bounds=page.bounds(for:.mediaBox), scale=3000/max(bounds.width,bounds.height)
    source=page.thumbnail(of:NSSize(width:bounds.width*scale,height:bounds.height*scale),for:.mediaBox)
} else {
    guard index == 0, let image=NSImage(contentsOf:input) else {fatalError("Unreadable image")}
    source=image
}
var rect=NSRect(origin:.zero,size:source.size)
guard let cg=source.cgImage(forProposedRect:&rect,context:nil,hints:nil) else {fatalError("Cannot decode")}
let ratio=min(1.0,3000/Double(max(cg.width,cg.height))), w=max(1,Int(Double(cg.width)*ratio)),h=max(1,Int(Double(cg.height)*ratio))
guard let context=CGContext(data:nil,width:w,height:h,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue) else {fatalError("Cannot render")}
context.setFillColor(NSColor.white.cgColor);context.fill(CGRect(x:0,y:0,width:w,height:h));context.interpolationQuality = .high
context.draw(cg,in:CGRect(x:0,y:0,width:w,height:h))
guard let image=context.makeImage(),let bytes=NSBitmapImageRep(cgImage:image).representation(using:.jpeg,properties:[.compressionFactor:0.92]) else {fatalError("Cannot encode")}
try bytes.write(to:output,options:.atomic)
print("{\"pages\":\(count),\"width\":\(w),\"height\":\(h)}")
