import DeviceCore
import Foundation

/// What the dashboard's routes answer, as the phone's pages read them: only
/// the fields a page draws, each list read one item at a time so one that
/// does not read leaves the rest. Times are epoch milliseconds, as KOS sends
/// them; `at` turns one into a date.
public enum Routes {
  /// A list, every item that reads.
  public struct List<Item: Decodable>: Decodable {
    public let items: [Item]

    public init(from decoder: Decoder) throws {
      items = try decoder.singleValueContainer().decode([Lenient<Item>].self).compactMap(\.value)
    }
  }

  /// An approval waiting on the owner (`/api/approvals`, `/api/inbox`).
  public struct Pending: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let tool: String
    public let args: String?
    public let reason: String?
    /// The action in words, with the ids named.
    public let summary: String?
    public let mechanics: String?
    public let why: String?
    public let conversationId: String?
    /// The chat asking, by the name the owner knows it by.
    public let asker: String?
    public let requestedAt: Double
    public let expiresAt: Double?
    /// What a yes remembered keeps, when one may be.
    public let rule: Rule?

    public struct Rule: Decodable, Equatable, Sendable {
      public let scope: String?
    }

    public init(
      id: Int, tool: String, args: String? = nil, reason: String? = nil, summary: String? = nil, mechanics: String? = nil, why: String? = nil,
      conversationId: String? = nil, asker: String? = nil, requestedAt: Double, expiresAt: Double? = nil, rule: Rule? = nil
    ) {
      self.id = id
      self.tool = tool
      self.args = args
      self.reason = reason
      self.summary = summary
      self.mechanics = mechanics
      self.why = why
      self.conversationId = conversationId
      self.asker = asker
      self.requestedAt = requestedAt
      self.expiresAt = expiresAt
      self.rule = rule
    }
  }

  /// One already decided (`/api/approvals/history`), said in words.
  public struct Decided: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let tool: String
    public let status: String
    public let summary: String
    public let asker: String?
    public let decidedAt: Double?
    public let requestedAt: Double
  }

  /// How many were decided, by outcome.
  public struct Counts: Decodable, Equatable, Sendable {
    public let approved: Int
    public let denied: Int
    public let expired: Int
  }

  /// A job failing now, as the Inbox and the overview say it.
  public struct Failing: Decodable, Equatable, Sendable {
    public let key: String
    public let label: String
    public let streak: Int
    public let error: String?
    public let since: Double
  }

  /// What waits on the owner (`/api/inbox`): the approvals and the jobs failing, and how many were decided.
  public struct Inbox: Decodable, Equatable, Sendable {
    public let approvals: [Pending]
    public let failures: [Failing]
    public let decided: Mark?

    public struct Mark: Decodable, Equatable, Sendable {
      public let total: Int
      public let latest: Double?
    }

    enum CodingKeys: String, CodingKey { case approvals, failures, decided }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      approvals = (try c.decodeIfPresent([Lenient<Pending>].self, forKey: .approvals) ?? []).compactMap(\.value)
      failures = (try c.decodeIfPresent([Lenient<Failing>].self, forKey: .failures) ?? []).compactMap(\.value)
      decided = try c.decodeIfPresent(Mark.self, forKey: .decided)
    }
  }

  /// A project (`/api/projects`).
  public struct Project: Decodable, Equatable, Identifiable, Sendable {
    public let slug: String
    public let name: String
    public let type: String?
    public let status: String
    public let description: String?
    /// The owner's colour for it, #rrggbb.
    public let colour: String?
    public let lastTouchedAt: Double
    public let tableCount: Int?
    public var id: String { slug }
  }

  /// An artifact as the gallery and a project's page list it.
  public struct Artifact: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    /// html, or an older widget page's spec.
    public let kind: String
    /// page, doc, deck or sheet.
    public let artifactKind: String
    public let description: String?
    public let projectSlug: String?
    public let blob: String?
    public let updatedAt: Double
    public let trashedAt: Double?

    /// One the phone opens: the HTML ones.
    public var opens: Bool { kind == "html" }
  }

  /// A chat as the dashboard lists it.
  public struct Chat: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let title: String
    public let updatedAt: Double
    /// working, needs-you, error or idle.
    public let activity: String?
    public let unread: Bool?
  }

  /// A table a project's migrations made, as its page counts it.
  public struct Table: Decodable, Equatable, Sendable {
    public let name: String
    /// -1 when it could not be counted.
    public let rows: Int
    public let columns: Int
  }

  /// One project's page (`/api/projects/<slug>/detail`).
  public struct ProjectDetail: Decodable, Equatable, Sendable {
    public let project: Project
    public let tables: [Table]
    public let pages: [Artifact]
    public let crons: [Cron]
    /// Its chats; its own orchestrator is not one.
    public let agents: [Chat]
    public let folder: String

    enum CodingKeys: String, CodingKey { case project, tables, pages, crons, agents, folder }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      project = try c.decode(Project.self, forKey: .project)
      tables = (try c.decodeIfPresent([Lenient<Table>].self, forKey: .tables) ?? []).compactMap(\.value)
      pages = (try c.decodeIfPresent([Lenient<Artifact>].self, forKey: .pages) ?? []).compactMap(\.value)
      crons = (try c.decodeIfPresent([Lenient<Cron>].self, forKey: .crons) ?? []).compactMap(\.value)
      agents = (try c.decodeIfPresent([Lenient<Chat>].self, forKey: .agents) ?? []).compactMap(\.value)
      folder = try c.decodeIfPresent(String.self, forKey: .folder) ?? "projects/\(project.slug)"
    }
  }

  /// A schedule (`/api/crons`).
  public struct Cron: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let name: String
    public let schedule: String
    public let type: String
    public let enabled: Bool
    public let projectSlug: String?
    public let running: Bool?
    public let lastRunAt: Double?
    public let nextRunAt: Double?
  }

  /// One run of a job (`/api/runs`).
  public struct Run: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let kind: String
    /// ok, error, running or skipped.
    public let status: String
    public let error: String?
    public let startedAt: Double
    public let ref: String?
    public let durationMs: Double?
  }

  /// A blob (`/api/agents`).
  public struct Blob: Decodable, Equatable, Identifiable, Sendable {
    public let name: String
    public let description: String
    public let folder: String
    public let conversationId: String
    public let project: String?
    public let thread: Thread?
    public let job: Job?
    public var id: String { name }

    public struct Thread: Decodable, Equatable, Sendable {
      public let activity: String
      public let unread: Bool
      public let updatedAt: Double
      public let lastSaid: String?
      public let lastError: String?
    }

    public struct Job: Decodable, Equatable, Sendable {
      public let id: Int
      public let schedule: String
      public let enabled: Bool
      public let lastRunAt: Double?
      public let nextRunAt: Double?
    }
  }

  /// What `/api/agents` answers.
  public struct Blobs: Decodable, Equatable, Sendable {
    public let agents: [Blob]

    enum CodingKeys: String, CodingKey { case agents }

    public init(from decoder: Decoder) throws {
      agents = (try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent([Lenient<Blob>].self, forKey: .agents) ?? []).compactMap(\.value)
    }
  }

  /// A chat's words, read (`/api/conversations/<id>/messages`): who said what, in order.
  public struct Transcript: Decodable, Equatable, Sendable {
    public let messages: [Message]

    public struct Message: Decodable, Equatable, Sendable {
      /// you or kos.
      public let role: String
      public let text: String
    }
  }

  /// A folder's entries (`/api/files`).
  public struct Folder: Decodable, Equatable, Sendable {
    public let path: String
    public let entries: [Entry]
  }

  public struct Entry: Decodable, Equatable, Identifiable, Sendable {
    public let name: String
    /// Workspace-relative, forward-slashed.
    public let path: String
    /// dir or file.
    public let kind: String
    public let size: Double
    public let modifiedAt: Double
    public var id: String { path }
    public var folder: Bool { kind == "dir" }
  }

  /// A file to read (`/api/file`): its words, or why there are none.
  public struct File: Decodable, Equatable, Sendable {
    public let path: String
    public let size: Double
    public let text: String?
    /// binary or too-large.
    public let omitted: String?
    public let language: String?
    /// What was read, when the words came out of a document: "docx, 12 paragraphs".
    public let extracted: String?
  }

  /// A claim KOS holds (`/api/memory`).
  public struct Claim: Decodable, Equatable, Identifiable, Sendable {
    public let id: Int
    public let key: String
    public let value: String
    /// fact or preference.
    public let kind: String
    public let scope: String
    public let source: String?
    public let tags: [String]
    public let pinned: Bool
    public let trust: String
    public let updatedAt: Double
  }

  public struct Memory: Decodable, Equatable, Sendable {
    public let facts: [Claim]

    enum CodingKeys: String, CodingKey { case facts }

    public init(from decoder: Decoder) throws {
      facts = (try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent([Lenient<Claim>].self, forKey: .facts) ?? []).compactMap(\.value)
    }
  }

  /// Where a claim came from and what it replaced (`/api/memory/trace`): the claims it took the place of, and the
  /// words it was drawn from.
  public struct Trace: Decodable, Equatable, Sendable {
    public let before: [Claim]
    public let evidence: [Evidence]

    public struct Evidence: Decodable, Equatable, Sendable {
      public let ts: Double
      /// owner or agent, as the log keeps it.
      public let role: String
      public let text: String
    }

    enum CodingKeys: String, CodingKey { case before, history, evidence }

    // A key no claim holds now answers with its history instead of what it replaced.
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      let replaced = try c.decodeIfPresent([Lenient<Claim>].self, forKey: .before) ?? c.decodeIfPresent([Lenient<Claim>].self, forKey: .history) ?? []
      before = replaced.compactMap(\.value).sorted { $0.updatedAt > $1.updatedAt }
      evidence = (try c.decodeIfPresent([Lenient<Evidence>].self, forKey: .evidence) ?? []).compactMap(\.value)
    }
  }

  /// The overview (`/api/home`): what the dashboard's first page draws from, the parts a phone shows.
  public struct Home: Decodable, Equatable, Sendable {
    public let approvals: [Pending]
    public let runs: [Run]
    public let health: Health
    public let projects: [Project]
    public let chats: [Chat]
    public let upcoming: [Upcoming]
    public let spend: Spend?
    public let memory: MemoryCount?

    enum CodingKeys: String, CodingKey { case approvals, runs, health, projects, chats, upcoming, spend, memory }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      func list<Item: Decodable>(_ key: CodingKeys) throws -> [Item] { (try c.decodeIfPresent([Lenient<Item>].self, forKey: key) ?? []).compactMap(\.value) }
      approvals = try list(.approvals)
      runs = try list(.runs)
      health = try c.decode(Health.self, forKey: .health)
      projects = try list(.projects)
      chats = try list(.chats)
      upcoming = try list(.upcoming)
      spend = try? c.decodeIfPresent(Spend.self, forKey: .spend)
      memory = try? c.decodeIfPresent(MemoryCount.self, forKey: .memory)
    }

    public struct Health: Decodable, Equatable, Sendable {
      public let failing: [Failing]
      public let recent: Recent

      public struct Recent: Decodable, Equatable, Sendable {
        public let total: Int
        public let errors: Int
      }
    }

    public struct Upcoming: Decodable, Equatable, Sendable {
      public let id: Int
      public let name: String
      public let at: Double
    }

    public struct Spend: Decodable, Equatable, Sendable {
      public let models: [Model]

      public struct Model: Decodable, Equatable, Sendable {
        public let model: String
        public let calls: Int
        public let cost: Double?
      }
    }

    public struct MemoryCount: Decodable, Equatable, Sendable {
      public let claims: Int
    }
  }
}

extension Double {
  /// Epoch milliseconds as a date.
  public var at: Date { Date(timeIntervalSince1970: self / 1000) }
}
