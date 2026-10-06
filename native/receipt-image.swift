import Foundation
import AppKit
import PDFKit
import Vision

// Produce bounded analysis copies. Never modify or replace the original.
let args=CommandLine.arguments
guard args.count==4 else {fatalError("Expected input, mime type and output directory")}
let input=URL(fileURLWithPath:args[1]), mime=args[2], output=URL(fileURLWithPath:args[3])
var sources:[NSImage]=[]
if mime == "application/pdf" {
    guard let doc=PDFDocument(url:input),doc.pageCount>0,doc.pageCount<=8 else {fatalError("PDF must contain 1 to 8 readable pages; split longer documents")}
    for i in 0..<doc.pageCount {
        guard let page=doc.page(at:i) else {fatalError("Unreadable PDF page")}
        let bounds=page.bounds(for:.mediaBox), scale=min(2.5,2200/max(bounds.width,bounds.height))
        sources.append(page.thumbnail(of:NSSize(width:bounds.width*scale,height:bounds.height*scale),for:.mediaBox))
    }
} else {
    guard let image=NSImage(contentsOf:input) else {fatalError("Unreadable receipt image")}
    sources.append(image)
}
var results:[[String:Any]]=[]
for (index,source) in sources.enumerated() {
    var rect=NSRect(origin:.zero,size:source.size)
    guard let cg=source.cgImage(forProposedRect:&rect,context:nil,hints:nil) else {fatalError("Cannot decode receipt")}
    let ratio=min(1.0,2200/Double(max(cg.width,cg.height))), width=max(1,Int(Double(cg.width)*ratio)),height=max(1,Int(Double(cg.height)*ratio))
    guard let context=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.noneSkipLast.rawValue) else {fatalError("Cannot create analysis image")}
    context.setFillColor(NSColor.white.cgColor);context.fill(CGRect(x:0,y:0,width:width,height:height));context.interpolationQuality = .high
    context.draw(cg,in:CGRect(x:0,y:0,width:width,height:height))
    guard let rendered=context.makeImage(),let data=NSBitmapImageRep(cgImage:rendered).representation(using:.jpeg,properties:[.compressionFactor:0.88]) else {fatalError("Cannot encode analysis image")}
    let dest=output.appendingPathComponent("page-\(index+1).jpg");try data.write(to:dest,options:.atomic)
    let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.usesLanguageCorrection=true;request.recognitionLanguages=["en-US","fr-CA"]
    try VNImageRequestHandler(cgImage:rendered).perform([request])
    let text=(request.results ?? []).compactMap{$0.topCandidates(1).first?.string}.joined(separator:"\n")
    results.append(["path":dest.path,"mime":"image/jpeg","text":text])
}
let json=try JSONSerialization.data(withJSONObject:results)
print(String(data:json,encoding:.utf8)!)
