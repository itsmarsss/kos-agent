import CoreGraphics
import DeviceCore
import DeviceKit
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import PhoneCore

/// The owner's artifacts on the phone: listed, opened as KOS drew them, their reads relayed by the phone's own call
/// numbers, and nothing else.
@MainActor
@Suite("Artifacts on the phone")
struct ArtifactShelfTests {
  private let opened = #"{"id":"plan","title":"Garden plan","kind":"doc","updatedAt":1761800000000,"place":{"kind":"project","name":"Garden"},"document":"<!doctype html>","themes":{"light":":root{}","dark":":root{--scheme:dark}"},"theme":"dark"}"#

  @Test func listsAndOpensOverTheLineInThePhonesTheme() async throws {
    let rig = try await Rig.online()
    rig.phone.artifacts.list()
    #expect(rig.line.events == ["chat.artifacts"])
    _ = try await rig.line.call("chat.artifacts", #"{"artifacts":[{"id":"plan","title":"Garden plan","kind":"doc","updatedAt":5}]}"#)
    #expect(rig.phone.artifacts.recent.map(\.id) == ["plan"])
    #expect(rig.phone.artifacts.listed)
    rig.phone.artifacts.open("plan", dark: true)
    #expect(rig.line.last("chat.artifact") as? [String: String] == ["id": "plan", "theme": "dark"])
    #expect(rig.phone.artifacts.shown == .loading(id: "plan", title: "Garden plan"))
    let reply = try await rig.line.call("chat.artifact", opened)
    #expect(reply["ok"] as? Bool == true)
    guard case .open(let artifact) = rig.phone.artifacts.shown else { Issue.record("not open"); return }
    #expect(artifact.title == "Garden plan" && artifact.kind == "doc" && artifact.place == .project("Garden") && artifact.dark)
    #expect(artifact.themes.dark == ":root{--scheme:dark}")
  }

  @Test func saysWhyOneDidNotOpenAndTakesOnlyTheOneAskedFor() async throws {
    let rig = try await Rig.online()
    rig.phone.artifacts.open("../etc", dark: false)
    #expect(rig.phone.artifacts.shown == .failed(id: "../etc", title: nil, why: "That is not an artifact's id."))
    #expect(rig.line.events.isEmpty)
    rig.phone.artifacts.open("nope", dark: false)
    _ = try await rig.line.call("chat.artifact", opened)
    #expect(rig.phone.artifacts.shown == .loading(id: "nope", title: nil))
    _ = try await rig.line.call("chat.artifact", #"{"id":"nope","error":"There is no artifact by that id that opens here."}"#)
    #expect(rig.phone.artifacts.shown == .failed(id: "nope", title: nil, why: "There is no artifact by that id that opens here."))
  }

  @Test func relaysTheOpenArtifactsReadsByItsOwnCallsAndRefusesTheRest() async throws {
    let rig = try await Rig.online()
    var answers: [ArtifactShelf.Answer] = []
    rig.phone.artifacts.read("query", args: .object([:])) { answers.append($0) }
    #expect(answers == [.failure(.init("The artifact is not open."))])
    rig.phone.artifacts.open("plan", dark: false)
    _ = try await rig.line.call("chat.artifact", opened)
    rig.line.forget()
    rig.phone.artifacts.read("write", args: .object([:])) { answers.append($0) }
    rig.phone.artifacts.read("query", args: .object(["sql": .string("SELECT 1")])) { answers.append($0) }
    rig.phone.artifacts.read("file", args: .object(["path": .string("notes.md")])) { answers.append($0) }
    #expect(rig.line.events == ["chat.read", "chat.read"])
    let first = try #require(rig.line.sent.first?["data"] as? [String: Any])
    #expect(first["artifact"] as? String == "plan" && first["call"] as? Int == 1 && first["method"] as? String == "query")
    // Answers come by call: another artifact's, and one for a call never made, are not taken.
    _ = try await rig.line.call("chat.read", #"{"artifact":"other","call":2,"result":1}"#)
    _ = try await rig.line.call("chat.read", #"{"artifact":"plan","call":2,"error":"no such file"}"#)
    _ = try await rig.line.call("chat.read", #"{"artifact":"plan","call":1,"result":{"rows":[]}}"#)
    _ = try await rig.line.call("chat.read", #"{"artifact":"plan","call":9,"result":1}"#)
    #expect(answers == [
      .failure(.init("The artifact is not open.")), .failure(.init("A phone only reads an artifact.")), .failure(.init("no such file")),
      .success(.object(["rows": .array([])])),
    ])
  }

  @Test func aReadKOSNeverAnswersIsRefusedInTimeAndClosingEndsTheRest() async throws {
    let rig = try await Rig.online()
    rig.phone.artifacts.open("plan", dark: false)
    _ = try await rig.line.call("chat.artifact", opened)
    var answers: [ArtifactShelf.Answer] = []
    rig.phone.artifacts.read("query", args: .null) { answers.append($0) }
    await settle()
    rig.sleeps.fire()
    await settle()
    #expect(answers == [.failure(.init("KOS did not answer in time; try again."))])
    rig.phone.artifacts.read("query", args: .null) { answers.append($0) }
    rig.phone.artifacts.close()
    #expect(answers.last == .failure(.init("The artifact was closed.")))
    #expect(rig.phone.artifacts.shown == nil)
  }

  @Test func nothingOfAnUnpairedKOSsArtifactsStays() async throws {
    let rig = try await Rig.online()
    _ = try await rig.line.call("chat.artifacts", #"{"artifacts":[{"id":"plan","title":"Garden plan","kind":"doc","updatedAt":5}]}"#)
    rig.phone.artifacts.open("plan", dark: false)
    rig.phone.unpair()
    #expect(rig.phone.artifacts.recent.isEmpty && rig.phone.artifacts.shown == nil)
  }
}

/// Photos and files picked to go with the owner's words: brought down, held to KOS's limits, sent ahead in parts,
/// and given back with the words when KOS never takes them.
@MainActor
@Suite("Files with the words")
struct AttachmentTests {
  /// A PNG of the size given, as a camera's photo would be: big.
  private func photo(_ width: Int, _ height: Int) throws -> Data {
    let context = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.3, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try #require(context.makeImage())
    let out = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    #expect(CGImageDestinationFinalize(destination))
    return out as Data
  }

  private func size(_ jpeg: Data) -> (Int, Int)? {
    guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil), let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return nil }
    return (props[kCGImagePropertyPixelWidth] as? Int ?? 0, props[kCGImagePropertyPixelHeight] as? Int ?? 0)
  }

  @Test func bringsAPhotoDownToAJPEGWithAThumbnail() throws {
    let tray = AttachmentTray()
    tray.addPicture(try photo(4032, 3024), name: "IMG_0042.HEIC")
    let file = try #require(tray.files.first)
    #expect(file.name == "IMG_0042.jpg" && file.mediaType == "image/jpeg" && file.isPicture)
    #expect(size(file.bytes).map { $0.0 == AttachmentTray.pictureEdge && $0.1 == 1536 } == true)
    #expect(size(try #require(file.thumbnail)).map { max($0.0, $0.1) == 168 } == true)
    // A small one is not made larger.
    tray.addPicture(try photo(300, 200))
    #expect(size(tray.files[1].bytes).map { $0.0 == 300 } == true)
    #expect(tray.files[1].name == "Photo 2.jpg")
  }

  @Test func takesWhatKOSReadsUpToItsLimits() throws {
    let tray = AttachmentTray()
    tray.addFile(Data("%PDF-1.7".utf8), name: "lease.pdf")
    tray.addFile(Data("a,b".utf8), name: "costs.csv")
    tray.addFile(Data("PK".utf8), name: "photos.zip")
    #expect(tray.note == "KOS cannot read photos.zip: send a picture, a PDF, an Office file or a text file.")
    tray.addFile(Data(count: AttachmentTray.largest + 1), name: "scan.pdf")
    #expect(tray.note == "scan.pdf is 5.0 MB; KOS takes files up to 5 MB.")
    #expect(tray.files.map(\.mediaType) == ["application/pdf", "text/csv"])
    tray.addFile(Data("x".utf8), name: "notes.md")
    tray.addFile(Data("{}".utf8), name: "plan.json")
    #expect(tray.full)
    tray.addFile(Data("y".utf8), name: "more.txt")
    #expect(tray.note == "4 files go with one message." && tray.files.count == 4)
    tray.remove(tray.files[0].id)
    #expect(tray.files.count == 3 && tray.note == nil)
  }

  @Test func sendsEachFileAheadInPartsThenTheWordsThatNameThem() async throws {
    let rig = try await Rig.online()
    rig.phone.tray.addFile(Data(repeating: 7, count: AttachmentPart.chars), name: "notes.txt")
    rig.phone.tray.addPicture(try photo(800, 600))
    let ids = rig.phone.tray.files.map(\.id)
    rig.phone.chat.say("what are these?", files: rig.phone.tray.files.map(\.name))
    #expect(rig.line.events == ["chat.attach", "chat.attach", "chat.attach", "chat.send"])
    let send = try #require(rig.line.last("chat.send"))
    #expect(send["files"] as? [String] == ids && send["text"] as? String == "what are these?")
    #expect(rig.phone.tray.files.isEmpty)
    #expect(rig.phone.chat.sendingFiles["what are these?"] == ["notes.txt", "Photo 2.jpg"])
    // KOS took them: they are done with, and do not come back.
    _ = try await rig.line.call("chat.status", #"{"chat":"phone:owner","said":"what are these?","taken":true}"#)
    _ = try await rig.line.call("chat.status", #"{"chat":"phone:owner","said":"what are these?","error":"too late"}"#)
    #expect(rig.phone.tray.files.isEmpty)
  }

  @Test func filesMayGoAloneAndACommandLeavesThemWaiting() async throws {
    let rig = try await Rig.online()
    rig.phone.tray.addFile(Data("milk".utf8), name: "list.txt")
    rig.phone.chat.say("/new", files: ["list.txt"])
    #expect(rig.line.last("chat.send")?["files"] == nil)
    #expect(rig.phone.tray.files.count == 1)
    rig.phone.chat.say("", files: ["list.txt"])
    #expect(rig.line.last("chat.send")?["text"] as? String == "")
    #expect((rig.line.last("chat.send")?["files"] as? [String])?.count == 1)
  }

  @Test func filesComeBackWithWordsKOSRefusedOrNeverTook() async throws {
    let rig = try await Rig.online()
    rig.phone.tray.addFile(Data("milk".utf8), name: "list.txt")
    rig.phone.chat.say("and this", files: ["list.txt"])
    _ = try await rig.line.call("chat.status", #"{"chat":"phone:owner","said":"and this","error":"list.txt did not arrive whole. Attach it again."}"#)
    #expect(rig.phone.tray.files.map(\.name) == ["list.txt"])
    #expect(rig.phone.chat.draft == "and this")
    rig.phone.chat.say("again", files: ["list.txt"])
    await settle()
    rig.sleeps.fire()
    await settle()
    #expect(rig.phone.tray.files.map(\.name) == ["list.txt"])
  }

  @Test func spokenWordsTakeThePickedFilesToo() async throws {
    let rig = try await Rig.online()
    rig.phone.tray.addFile(Data("milk".utf8), name: "list.txt")
    rig.phone.voice.press()
    await settle()
    rig.speech.say("what is on this list", final: true)
    await settle()
    #expect((rig.line.last("chat.send")?["files"] as? [String])?.count == 1)
  }
}
