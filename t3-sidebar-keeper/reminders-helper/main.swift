import AppKit
import Foundation
import UserNotifications
import Darwin

// Static chrome matches COPY.md. Notification title, body, and the Snooze
// button title come from Node at post time so a later settings change cannot
// retitle a banner that is already on screen. This process never quits or
// restarts T3.

enum Copy {
  static let windowTitle = "T3 Restart Reminders"
  static let statusRestart = "Restart needed. Quit T3 Code (⌘Q) and reopen it. This app never restarts it for you."
  static let statusClosed = "T3 Code is closed. Open it to load the updated patches."
  static let statusNone = "No restart needed. Reminders start again if an update needs one."
  static let intervalLabel = "Remind me every"
  static let intervalChoices = ["5 minutes", "15 minutes", "30 minutes", "1 hour", "Custom…"]
  static let snoozeLabel = "Snooze for"
  static let snoozeChoices = ["1 Hour", "3 Hours", "6 Hours", "Custom…"]
  static let customSuffix = "minutes"
  static let save = "Save"
  static let snoozeButton = "Snooze"
  static let resume = "Resume Reminders"
  static let resumeCaption = "Ends the snooze. If a restart is still needed, you'll get a reminder right away."
  static let dismissNote = "Closing a notification doesn't snooze it."
  static let permission = "Notifications are off, so reminders can't appear."
  static let openSettings = "Open Notification Settings"
  static let setupTitle = "Set Up Restart Reminders"
  static let setupBody = "After an update, T3 Code may need a full quit and reopen to load your patches. Allow notifications so this app can remind you. It never quits or restarts T3 Code."
  static let allow = "Allow Notifications"
  static let notNow = "Not Now"
  static let setupTip = "To keep reminders on screen, choose Alerts in Notification Settings."
  static let saveFailed = "Couldn't save that change. Try again."
  static let stale = "That reminder was out of date, so nothing changed."
  static let customError = "Enter a whole number from"
}

let threadIdentifier = "com.cornishandy.t3-restart-reminders"
let noticeIdentifier = "com.cornishandy.t3-restart-reminders.notice"
private let retained = AppDelegate()

@main
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, UNUserNotificationCenterDelegate {
  var actionsInFlight = 0
  var quiescing = false
  var notificationResponseSeen = false
  var interactiveMode = false
  var signalSource: DispatchSourceSignal?
  var controlsNamespace = "production"
  var controlsGeneration: String?
  var intervalPopup: NSPopUpButton?
  var snoozePopup: NSPopUpButton?
  var controlsWindow: NSWindow?
  var statusLabel: NSTextField?
  var messageLabel: NSTextField?
  var permissionLabel: NSTextField?
  var intervalCustom: NSTextField?
  var snoozeCustom: NSTextField?
  var intervalSave: NSButton?
  var snoozeApply: NSButton?

  static func main() {
    guard admitNative() else { exit(75) }
    let disabled = (keeperHome() as NSString).appendingPathComponent("restart-reminders-disabled.json")
    if FileManager.default.fileExists(atPath: disabled), option("--mode") != "clear-all" {
      emit(["ok": true, "accepted": false, "disabled": true, "requested": false, "posted": false, "nodeInvoked": false])
      exit(0)
    }
    // Bounded headless operations do not create AppKit's application or install
    // a response delegate. They cannot re-enter Node or open Controls through
    // this notification delegate while the scheduler holds its locks.
    if retained.runHeadlessIfNeeded() { return }
    retained.interactiveMode = true
    let app = NSApplication.shared
    app.delegate = retained
    signal(SIGTERM, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    source.setEventHandler {
      retained.quiescing = true
      if retained.actionsInFlight == 0 { NSApp.terminate(nil) }
    }
    source.resume()
    retained.signalSource = source
    app.setActivationPolicy(.accessory)
    UNUserNotificationCenter.current().delegate = retained
    app.run()
  }

  func applicationWillFinishLaunching(_ notification: Notification) {
    UNUserNotificationCenter.current().delegate = self
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let mode = option("--mode") ?? "controls"
    if mode == "lifecycle-probe" {
      runLifecycleProbe()
      return
    }
    if mode == "setup" {
      showSetup()
    } else if mode == "controls" {
      // A notification action starts this app in the background. Only an
      // ordinary LaunchServices open should display the default controls.
      let normal = notification.userInfo?[NSApplication.launchIsDefaultUserInfoKey] as? Bool ?? false
      if option("--mode") == "controls" || normal { showControls() }
    }
  }

  func finishResponse(_ completion: () -> Void) {
    completion()
    scheduleIdleExit()
  }

  func scheduleIdleExit() {
    DispatchQueue.main.async {
      if self.actionsInFlight == 0 && (self.quiescing || self.controlsWindow == nil) { NSApp.terminate(nil) }
    }
  }

  func runLifecycleProbe() {
    guard option("--namespace") == "diagnostic", let generation = option("--generation"), generation.hasPrefix("test-") else {
      emit(["ok": false, "error": "diagnostic-rejected"]); NSApp.terminate(nil); return
    }
    if CommandLine.arguments.contains("--probe-window") { controlsWindow = NSWindow() }
    if CommandLine.arguments.contains("--probe-in-flight") { actionsInFlight = 1 }
    let keptAlive = controlsWindow != nil || actionsInFlight > 0
    let branch = option("--probe-branch") ?? "dismiss"
    let hold = Double(option("--probe-hold-seconds") ?? "0.1") ?? 0.1
    guard ["dismiss", "invalid", "unknown"].contains(branch), hold >= 0.1, hold <= 3 else { NSApp.terminate(nil); return }
    finishResponse { emit(["ok": true, "branch": branch, "completionCalled": true, "keptAlive": keptAlive, "nodeInvoked": false]) }
    if keptAlive {
      DispatchQueue.main.asyncAfter(deadline: .now() + hold) {
        emit(["ok": true, "preservedWindowOrAction": true])
        self.controlsWindow = nil; self.actionsInFlight = 0; self.scheduleIdleExit()
      }
    }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !quiescing { showControls() }
    return true
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .list, .sound])
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    actionsInFlight == 0
  }

  func windowWillClose(_ notification: Notification) {
    if let window = notification.object as? NSWindow, window === controlsWindow {
      controlsWindow = nil
      if actionsInFlight == 0 { NSApp.terminate(nil) }
    }
  }

  /// Modes that must not open a window or ask for notification permission.
  func runHeadlessIfNeeded() -> Bool {
    guard let mode = option("--mode") else { return false }
    switch mode {
    case "post":
      runPost(dryRun: CommandLine.arguments.contains("--dry-run"))
    case "auth-status":
      runAuthStatus()
    case "clear":
      runClear()
    case "clear-all":
      runClearAll()
    case "deliver-action":
      runDeliverAction()
    case "classify-cli-result":
      runClassify()
    case "controls", "setup", "lifecycle-probe":
      return false
    default:
      emit(["ok": false, "error": "usage", "message": "unknown mode"])
      exit(64)
    }
    return true
  }

  func runPost(dryRun: Bool) {
    _ = readStdin()
    if dryRun {
      emit([
        "ok": true,
        "accepted": false,
        "dryRun": true,
        "requested": false,
        "posted": false,
        "nodeInvoked": false,
      ])
      exit(0)
    }
    let raw = readStdinAlreadyConsumed()
    guard let payload = parseObject(raw) else {
      emit(["ok": false, "accepted": false, "error": "malformed-payload", "requested": false, "posted": false])
      exit(1)
    }
    guard let namespace = payload["namespace"] as? String,
          let generation = payload["generation"] as? String,
          validNamespace(namespace, generation),
          let captured = payload["capturedSnoozeMs"] as? NSNumber,
          captured.doubleValue.truncatingRemainder(dividingBy: 60000) == 0,
          captured.doubleValue >= 60000, captured.doubleValue <= 2592000000 else {
      emit(["ok": false, "accepted": false, "error": "invalid-payload", "nodeInvoked": false]); exit(1)
    }
    let box = FlagBox()
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      box.name = authName(settings.authorizationStatus)
      box.done = true
    }
    spinUntil { box.done }
    if box.name != "authorized" && box.name != "provisional" && box.name != "ephemeral" {
      let denied = box.name == "denied" || box.name == "not-determined"
      emit([
        "ok": true,
        "accepted": false,
        "denied": denied,
        "authorization": box.name,
        "requested": false,
        "posted": false,
        "nodeInvoked": false,
      ])
      exit(0)
    }
    let title = stringField(payload, "title") ?? Copy.windowTitle
    let body = stringField(payload, "body") ?? ""
    let actionTitle = stringField(payload, "snoozeActionTitle") ?? "Snooze"
    let minutes = ((payload["capturedSnoozeMs"] as? NSNumber)?.intValue ?? 0) / 60000
    let categoryId = "\(threadIdentifier).snooze.\(minutes)"
    let snooze = UNNotificationAction(identifier: "snooze", title: actionTitle, options: [])
    // The response delegate presents the correct namespace itself. Asking the
    // OS to foreground too can independently reopen the default controls.
    let controls = UNNotificationAction(identifier: "controls", title: "Controls…", options: [])
    let category = UNNotificationCategory(
      identifier: categoryId,
      actions: [snooze, controls],
      intentIdentifiers: [],
      options: [.customDismissAction]
    )
    let posted = FlagBox()
    let center = UNUserNotificationCenter.current()
    let submit = {
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.threadIdentifier = threadIdentifier
      content.categoryIdentifier = categoryId
      content.userInfo = [
        "generation": stringField(payload, "generation") ?? "",
        "capturedSnoozeMs": payload["capturedSnoozeMs"] ?? 0,
        "namespace": namespace,
        "snoozeActionTitle": actionTitle,
      ]
      let request = UNNotificationRequest(identifier: noticeID(namespace, generation), content: content, trigger: nil)
      center.add(request) { error in
        posted.name = error == nil ? "accepted" : "add-failed"
        posted.done = true
      }
    }
    center.getNotificationCategories { existing in
      var categories = existing.filter { $0.identifier != categoryId }
      categories.insert(category)
      center.setNotificationCategories(categories)
      submit()
    }
    spinUntil { posted.done }
    let accepted = posted.name == "accepted"
    // Explicit test-only overlap, bounded to ten seconds. Normal timer posting
    // stays one-shot and immediate. No delegate or Node callback runs here.
    if namespace == "diagnostic", let seconds = payload["diagnosticHoldSeconds"] as? NSNumber,
       seconds.intValue >= 1, seconds.intValue <= 10 {
      let file = URL(fileURLWithPath: keeperHome()).appendingPathComponent("reminder-diagnostic-overlap.json")
      let fields: [String: Any] = ["generation": generation, "pid": ProcessInfo.processInfo.processIdentifier, "seconds": seconds.intValue, "active": true]
      if let data = try? JSONSerialization.data(withJSONObject: fields) { try? data.write(to: file, options: .atomic) }
      let until = Date().addingTimeInterval(seconds.doubleValue)
      while Date() < until { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
      try? FileManager.default.removeItem(at: file)
    }
    emit([
      "ok": true,
      "accepted": accepted,
      "denied": false,
      "authorization": box.name,
      "requested": false,
      "posted": accepted,
      "nodeInvoked": false,
      "error": accepted ? NSNull() : "add-failed",
    ])
    exit(accepted ? 0 : 1)
  }

  func runAuthStatus() {
    let box = FlagBox()
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      box.fields = ["authorization": authName(settings.authorizationStatus), "alertSetting": settings.alertSetting.rawValue, "notificationCenterSetting": settings.notificationCenterSetting.rawValue, "alertStyle": settings.alertStyle.rawValue]
      box.done = true
    }
    spinUntil { box.done }
    emit(box.fields.merging(["ok": box.done, "requested": false, "nodeInvoked": false]) { _, new in new })
    exit(box.done ? 0 : 1)
  }

  func runClear() {
    let namespace = option("--namespace") ?? ""
    let generation = option("--generation") ?? ""
    guard validNamespace(namespace, generation) else {
      emit(["ok": false, "error": "generation", "nodeInvoked": false]); exit(1)
    }
    let center = UNUserNotificationCenter.current()
    let id = noticeID(namespace, generation)
    center.removeDeliveredNotifications(withIdentifiers: [id])
    center.removePendingNotificationRequests(withIdentifiers: [id])
    emit(["ok": true, "requested": false, "cleared": generation, "namespace": namespace, "nodeInvoked": false])
    exit(0)
  }

  // Only this helper's bundle notifications; reload notices use osascript
  // separately and are deliberately left alone.
  func runClearAll() {
    let center = UNUserNotificationCenter.current()
    center.removeAllDeliveredNotifications()
    center.removeAllPendingNotificationRequests()
    let delivered = FlagBox()
    center.getDeliveredNotifications { notices in
      delivered.fields = ["delivered": notices.count]
      delivered.done = true
    }
    spinUntil { delivered.done }
    let pending = FlagBox()
    center.getPendingNotificationRequests { requests in
      pending.fields = ["pending": requests.count]
      pending.done = true
    }
    spinUntil { pending.done }
    let ok = delivered.done && pending.done && delivered.fields["delivered"] as? Int == 0 && pending.fields["pending"] as? Int == 0
    emit(["ok": ok, "delivered": delivered.fields["delivered"] ?? -1, "pending": pending.fields["pending"] ?? -1, "nodeInvoked": false])
    exit(ok ? 0 : 1)
  }

  func runClassify() {
    let raw = readStdin()
    guard let input = parseObject(raw) else {
      emit(["ok": false, "success": false, "reason": "malformed"])
      exit(1)
    }
    let status = (input["status"] as? NSNumber)?.int32Value ?? -1
    let stdout = stringField(input, "stdout") ?? ""
    let kind = stringField(input, "kind") ?? "snooze"
    let verdict = judge(status: status, stdout: stdout, kind: kind)
    emit([
      "ok": verdict.success,
      "success": verdict.success,
      "reason": verdict.reason,
      "cliStatus": status,
    ])
    exit(verdict.success ? 0 : 1)
  }

  func runDeliverAction() {
    if rejectsStatePath(CommandLine.arguments) {
      let payload: [String: Any] = ["ok": false, "success": false, "error": "state-path", "message": "state paths are not accepted"]
      emit(payload)
      logFailure(payload)
      exit(1)
    }
    let action = option("--action") ?? ""
    let generation = option("--generation") ?? ""
    let namespace = option("--namespace") ?? ""
    let captured = option("--captured-ms") ?? ""
    if namespace != "production" && namespace != "diagnostic" {
      failAction(error: "namespace", message: "namespace is not production or diagnostic", status: 1)
    }
    if namespace == "diagnostic" && !generation.hasPrefix("test-") {
      failAction(error: "diagnostic-rejected", message: "diagnostic actions require a test- generation", status: 1)
    }
    if action != "snooze" && action != "controls" && action != "dismiss" {
      failAction(error: "invalid-action", message: "unknown reminder action", status: 1)
    }
    let timeout = Double(option("--timeout-seconds") ?? "") ?? 20
    let run = runNode(arguments: [
      "--reminder-action", action,
      "--generation", generation,
      "--captured-ms", captured,
      "--namespace", namespace,
    ], timeout: timeout)
    if run.timedOut {
      failAction(error: "timeout", message: Copy.saveFailed, status: 1)
    }
    if run.missingTool {
      failAction(error: "node-missing", message: "The reminder helper could not find node or reminders.mjs.", status: 1)
    }
    let verdict = judge(status: run.status, stdout: run.stdout, kind: action == "snooze" ? "snooze" : "other")
    var payload: [String: Any] = [
      "ok": verdict.success,
      "success": verdict.success,
      "cliStatus": run.status,
      "reason": verdict.reason,
      "nodeInvoked": true,
      "posted": false,
    ]
    if let message = verdict.message { payload["message"] = message }
    if let until = verdict.snoozeUntil { payload["snoozeUntil"] = until }
    if let error = verdict.error { payload["error"] = error }
    emit(payload)
    if !verdict.success { logFailure(payload) }
    let code: Int32
    if run.status == 75 { code = 75 }
    else if run.status == 2 { code = 2 }
    else { code = verdict.success ? 0 : 1 }
    exit(code)
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
    guard interactiveMode else { completionHandler(); return }
    notificationResponseSeen = true
    let info = response.notification.request.content.userInfo
    guard let namespace = info["namespace"] as? String,
          let generation = info["generation"] as? String,
          validNamespace(namespace, generation) else {
      logFailure(["ok": false, "error": "payload", "message": Copy.stale])
      finishResponse(completionHandler); return
    }
    if quiescing {
      showControls(namespace: namespace)
      messageLabel?.stringValue = "The reminder helper is updating. Try again."
      finishResponse(completionHandler); return
    }
    let action = response.actionIdentifier
    if action == UNNotificationDefaultActionIdentifier || action == "controls" {
      showControls(namespace: namespace)
      if controlsGeneration != generation { messageLabel?.stringValue = Copy.stale }
      finishResponse(completionHandler); return
    }
    guard action == "snooze" else { finishResponse(completionHandler); return } // dismissal never mutates state
    let captured = (info["capturedSnoozeMs"] as? NSNumber)?.stringValue ?? ""
    performNode(arguments: ["--reminder-action", "snooze", "--generation", generation, "--captured-ms", captured, "--namespace", namespace]) { run in
      let verdict = judge(status: run.status, stdout: run.stdout, kind: "snooze")
      if !verdict.success {
        logFailure(["ok": false, "error": verdict.error ?? verdict.reason, "message": verdict.message ?? Copy.saveFailed, "cliStatus": run.status])
        self.showControls(namespace: namespace)
        self.messageLabel?.stringValue = verdict.message ?? Copy.saveFailed
      } else if self.controlsWindow != nil {
        if self.controlsNamespace == namespace { self.messageLabel?.stringValue = "" }
        self.refreshStatus()
      }
      self.finishResponse(completionHandler)
    }
  }

  func performNode(arguments: [String], completion: @escaping (NodeRun) -> Void) {
    actionsInFlight += 1
    let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .suddenTerminationDisabled], reason: "Saving a restart-reminder choice")
    DispatchQueue.global(qos: .userInitiated).async {
      let result = runNodeRetryingBusy(arguments: arguments)
      DispatchQueue.main.async {
        completion(result)
        self.actionsInFlight -= 1
        ProcessInfo.processInfo.endActivity(activity)
        self.scheduleIdleExit()
      }
    }
  }

  func showControls(namespace: String = "production") {
    controlsNamespace = namespace
    messageLabel?.stringValue = ""
    if let window = controlsWindow {
      window.title = namespace == "diagnostic" ? "TEST — \(Copy.windowTitle)" : Copy.windowTitle
      window.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      refreshStatus()
      return
    }
    let status = wrappingLabel(Copy.statusNone)
    statusLabel = status
    let message = wrappingLabel("")
    message.font = NSFont.systemFont(ofSize: 12)
    messageLabel = message
    let intervalPopup = NSPopUpButton()
    self.intervalPopup = intervalPopup
    intervalPopup.addItems(withTitles: Copy.intervalChoices)
    intervalPopup.target = self
    intervalPopup.action = #selector(intervalChanged(_:))
    let intervalField = NSTextField(string: "")
    intervalField.placeholderString = "15 minutes"
    intervalField.isHidden = true
    intervalCustom = intervalField
    let save = NSButton(title: Copy.save, target: self, action: #selector(saveInterval))
    save.isHidden = true
    intervalSave = save
    let snoozePopup = NSPopUpButton()
    self.snoozePopup = snoozePopup
    snoozePopup.addItems(withTitles: Copy.snoozeChoices)
    snoozePopup.target = self
    snoozePopup.action = #selector(snoozeChanged(_:))
    let snoozeField = NSTextField(string: "")
    snoozeField.placeholderString = "180 minutes"
    snoozeField.isHidden = true
    snoozeCustom = snoozeField
    let snoozeButton = NSButton(title: Copy.snoozeButton, target: self, action: #selector(applyCustomSnooze))
    snoozeButton.isHidden = true
    snoozeApply = snoozeButton
    let resume = NSButton(title: Copy.resume, target: self, action: #selector(resumeReminders))
    let permission = wrappingLabel(Copy.permission)
    permission.isHidden = true
    permissionLabel = permission
    let settings = NSButton(title: Copy.openSettings, target: self, action: #selector(openNotificationSettings))
    let stack = NSStackView(views: [
      status,
      labeled(Copy.intervalLabel, intervalPopup),
      intervalField,
      save,
      labeled(Copy.snoozeLabel, snoozePopup),
      snoozeField,
      snoozeButton,
      resume,
      wrappingLabel(Copy.resumeCaption),
      wrappingLabel(Copy.dismissNote),
      permission,
      settings,
      message,
    ])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 8
    stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 440, height: 520),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    window.title = namespace == "diagnostic" ? "TEST — \(Copy.windowTitle)" : Copy.windowTitle
    window.delegate = self
    window.contentView = stack
    window.isReleasedWhenClosed = false
    window.center()
    controlsWindow = window
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    refreshStatus()
    refreshPermission()
  }

  func showSetup() {
    let stack = NSStackView(views: [
      wrappingLabel(Copy.setupBody),
      wrappingLabel(Copy.setupTip),
      NSButton(title: Copy.allow, target: self, action: #selector(allowNotifications)),
      NSButton(title: Copy.notNow, target: self, action: #selector(closeSetup)),
    ])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 440, height: 280),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    window.title = Copy.setupTitle
    window.delegate = self
    window.contentView = stack
    window.isReleasedWhenClosed = false
    window.center()
    controlsWindow = window
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc func allowNotifications() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in
      DispatchQueue.main.async { self.closeSetup() }
    }
  }

  @objc func closeSetup() {
    controlsWindow?.close()
    controlsWindow = nil
    NSApp.terminate(nil)
  }

  @objc func intervalChanged(_ sender: NSPopUpButton) {
    let custom = sender.titleOfSelectedItem == "Custom…"
    intervalCustom?.isHidden = !custom
    intervalSave?.isHidden = !custom
    guard !custom, let title = sender.titleOfSelectedItem else { return }
    let duration: String
    switch title {
    case "5 minutes": duration = "5m"
    case "15 minutes": duration = "15m"
    case "30 minutes": duration = "30m"
    case "1 hour": duration = "1h"
    default: return
    }
    mutate(arguments: ["--remind-every", duration])
  }

  @objc func saveInterval() {
    guard let text = intervalCustom?.stringValue else { return }
    mutate(arguments: ["--remind-every", text.trimmingCharacters(in: .whitespaces)])
  }

  @objc func snoozeChanged(_ sender: NSPopUpButton) {
    let custom = sender.titleOfSelectedItem == "Custom…"
    snoozeCustom?.isHidden = !custom
    snoozeApply?.isHidden = !custom
    guard !custom, let title = sender.titleOfSelectedItem else { return }
    let duration: String
    switch title {
    case "1 Hour": duration = "1h"
    case "3 Hours": duration = "3h"
    case "6 Hours": duration = "6h"
    default: return
    }
    mutate(arguments: ["--snooze", duration])
  }

  @objc func applyCustomSnooze() {
    guard let text = snoozeCustom?.stringValue else { return }
    mutate(arguments: ["--snooze", text.trimmingCharacters(in: .whitespaces)])
  }

  @objc func resumeReminders() {
    mutate(arguments: ["--resume-reminders"])
  }

  @objc func openNotificationSettings() {
    if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") {
      NSWorkspace.shared.open(url)
    }
  }

  func mutate(arguments: [String]) {
    guard !quiescing else { messageLabel?.stringValue = "The reminder helper is updating. Try again."; return }
    let full = arguments + ["--namespace", controlsNamespace, "--generation", controlsGeneration ?? "__none__"]
    performNode(arguments: full) { run in
      let verdict = judge(status: run.status, stdout: run.stdout, kind: arguments.contains("--snooze") ? "snooze" : "mutation")
      self.messageLabel?.stringValue = verdict.success ? "" : (verdict.message ?? Copy.saveFailed)
      if !verdict.success { logFailure(["ok": false, "error": verdict.error ?? verdict.reason, "message": self.messageLabel?.stringValue ?? ""]) }
      self.refreshStatus()
    }
  }

  func refreshStatus() {
    let run = runNode(arguments: ["--reminders", "--namespace", controlsNamespace], timeout: 20)
    guard run.status == 0, let obj = parseObject(run.stdout), obj["ok"] as? Bool == true,
          let presentation = obj["presentation"] as? [String: Any], let text = presentation["statusText"] as? String else {
      statusLabel?.stringValue = "Couldn't read reminder status. Try again."
      return
    }
    controlsGeneration = (obj["pending"] as? [String: Any])?["generation"] as? String
    statusLabel?.stringValue = controlsNamespace == "diagnostic" ? "Diagnostic test only. \(text)" : text
    if let config = obj["config"] as? [String: Any] {
      let interval = (config["intervalMs"] as? NSNumber)?.intValue ?? 900000
      let snooze = (config["snoozeMs"] as? NSNumber)?.intValue ?? 10800000
      let intervalIndex = [300000, 900000, 1800000, 3600000].firstIndex(of: interval) ?? 4
      let snoozeIndex = [3600000, 10800000, 21600000].firstIndex(of: snooze) ?? 3
      intervalPopup?.selectItem(at: intervalIndex)
      snoozePopup?.selectItem(at: snoozeIndex)
      intervalCustom?.stringValue = String(interval / 60000)
      snoozeCustom?.stringValue = String(snooze / 60000)
      intervalCustom?.isHidden = intervalIndex != 4; intervalSave?.isHidden = intervalIndex != 4
      snoozeCustom?.isHidden = snoozeIndex != 3; snoozeApply?.isHidden = snoozeIndex != 3
    }
  }

  func refreshPermission() {
    let box = FlagBox()
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      box.name = authName(settings.authorizationStatus)
      box.done = true
    }
    spinUntil { box.done }
    let off = box.name == "denied" || box.name == "not-determined"
    permissionLabel?.isHidden = !off
    permissionLabel?.stringValue = Copy.permission
  }
}

final class FlagBox: @unchecked Sendable {
  private let lock = NSLock()
  private var _done = false
  private var _name = "unknown"
  private var _fields: [String: Any] = [:]
  var done: Bool { get { lock.lock(); defer { lock.unlock() }; return _done } set { lock.lock(); _done = newValue; lock.unlock() } }
  var name: String { get { lock.lock(); defer { lock.unlock() }; return _name } set { lock.lock(); _name = newValue; lock.unlock() } }
  var fields: [String: Any] { get { lock.lock(); defer { lock.unlock() }; return _fields } set { lock.lock(); _fields = newValue; lock.unlock() } }
}

struct NodeRun {
  var status: Int32 = 1
  var stdout = ""
  var stderr = ""
  var timedOut = false
  var missingTool = false
}

struct CliVerdict {
  var success = false
  var reason = "malformed"
  var message: String?
  var error: String?
  var snoozeUntil: String?
}

func judge(status: Int32, stdout: String, kind: String) -> CliVerdict {
  guard let obj = parseObject(stdout) else {
    return CliVerdict(success: false, reason: "malformed", message: Copy.saveFailed, error: "malformed")
  }
  let ok = obj["ok"] as? Bool == true
  let error = obj["error"] as? String
  let message = obj["message"] as? String
  if status == 75 || error == "busy" {
    return CliVerdict(success: false, reason: "busy", message: message ?? Copy.saveFailed, error: "busy")
  }
  if error == "stale" || obj["stale"] as? Bool == true {
    return CliVerdict(success: false, reason: "stale", message: message ?? Copy.stale, error: "stale")
  }
  if status != 0 || !ok {
    return CliVerdict(success: false, reason: error ?? "cli-status", message: message ?? Copy.saveFailed, error: error ?? "cli-status")
  }
  if (kind == "snooze" || kind == "mutation") && obj["durable"] as? Bool != true {
    return CliVerdict(success: false, reason: "not-durable", message: Copy.saveFailed, error: "not-durable")
  }
  if kind == "snooze" {
    guard let until = obj["snoozeUntil"] as? String, ISO8601DateFormatter.fractional.date(from: until) != nil, (obj["appliedMs"] as? NSNumber)?.intValue ?? 0 > 0 else {
      return CliVerdict(success: false, reason: "malformed", message: Copy.saveFailed, error: "malformed")
    }
    return CliVerdict(success: true, reason: "ok", message: message, snoozeUntil: until)
  }
  return CliVerdict(success: true, reason: "ok", message: message)
}

func runNode(arguments: [String], timeout: Double) -> NodeRun {
  guard let node = nodeBinary(), let script = remindersScript() else {
    return NodeRun(missingTool: true)
  }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: node)
  process.arguments = [script] + arguments
  // LaunchServices/cold notification launches have no shell environment.
  // Both namespaces always resolve under this bundle's fixed sibling keeper
  // directory; no notification can supply a path or override production state.
  process.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "T3_KEEPER_HOME": keeperHome()]
  let out = Pipe()
  let err = Pipe()
  process.standardOutput = out
  process.standardError = err
  do { try process.run() } catch {
    return NodeRun(missingTool: true)
  }
  let deadline = Date().addingTimeInterval(timeout)
  while process.isRunning && Date() < deadline {
    Thread.sleep(forTimeInterval: 0.05)
  }
  if process.isRunning {
    process.terminate()
    let killBy = Date().addingTimeInterval(1)
    while process.isRunning && Date() < killBy { Thread.sleep(forTimeInterval: 0.05) }
    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    return NodeRun(timedOut: true)
  }
  let stdout = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  let stderr = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  return NodeRun(status: process.terminationStatus, stdout: stdout, stderr: stderr)
}

func nodeBinary() -> String? {
  for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
    if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
  }
  return nil
}

func remindersScript() -> String? {
  let raw = Bundle.main.executableURL?.path ?? CommandLine.arguments[0]
  let exe = URL(fileURLWithPath: raw).resolvingSymlinksInPath()
  let app = exe.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  let script = app.deletingLastPathComponent().appendingPathComponent("reminders.mjs").path
  return FileManager.default.isReadableFile(atPath: script) ? script : nil
}

func keeperHome() -> String {
  // Admission must keep its fixed bundle sibling even while the installer has
  // temporarily removed the module. Never fall back to another user's/home's
  // production directory just because that sibling is not readable yet.
  let raw = Bundle.main.executableURL?.path ?? CommandLine.arguments[0]
  let exe = URL(fileURLWithPath: raw).resolvingSymlinksInPath()
  return exe.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().path
}

func failAction(error: String, message: String, status: Int32) -> Never {
  let payload: [String: Any] = ["ok": false, "success": false, "error": error, "message": message, "posted": false, "nodeInvoked": false]
  emit(payload)
  logFailure(payload)
  exit(status)
}

func logFailure(_ fields: [String: Any]) {
  let dir = URL(fileURLWithPath: keeperHome(), isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  var line = fields
  line["at"] = ISO8601DateFormatter().string(from: Date())
  guard var data = try? JSONSerialization.data(withJSONObject: line) else { return }
  data.append(0x0A)
  let url = dir.appendingPathComponent("reminder-helper.log")
  if FileManager.default.fileExists(atPath: url.path), let handle = try? FileHandle(forWritingTo: url) {
    _ = try? handle.seekToEnd()
    try? handle.write(contentsOf: data)
    try? handle.close()
  } else {
    try? data.write(to: url)
  }
}

func rejectsStatePath(_ args: [String]) -> Bool {
  let banned = ["--state", "--state-file", "--state-path", "--file", "--home", "--journal"]
  return args.contains { banned.contains($0) || $0.hasPrefix("--state=") || $0.hasPrefix("--file=") }
}

func option(_ name: String) -> String? {
  guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
  return CommandLine.arguments[index + 1]
}

private var consumedStdin: String?

func readStdin() -> String {
  if let consumedStdin { return consumedStdin }
  let data = FileHandle.standardInput.readDataToEndOfFile()
  let text = String(data: data, encoding: .utf8) ?? ""
  consumedStdin = text
  return text
}

func readStdinAlreadyConsumed() -> String {
  consumedStdin ?? ""
}

func parseObject(_ text: String) -> [String: Any]? {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  guard let data = trimmed.data(using: .utf8),
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
  return obj
}

func stringField(_ obj: [String: Any], _ key: String) -> String? {
  obj[key] as? String
}

func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

func authName(_ status: UNAuthorizationStatus) -> String {
  switch status {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .provisional: return "provisional"
  case .ephemeral: return "ephemeral"
  case .notDetermined: return "not-determined"
  @unknown default: return "unknown"
  }
}

func spinUntil(_ ready: () -> Bool) {
  let deadline = Date().addingTimeInterval(4)
  while !ready() && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  }
}

func wrappingLabel(_ text: String) -> NSTextField {
  let label = NSTextField(wrappingLabelWithString: text)
  label.preferredMaxLayoutWidth = 400
  return label
}

func labeled(_ title: String, _ control: NSView) -> NSStackView {
  let stack = NSStackView(views: [NSTextField(labelWithString: title), control])
  stack.orientation = .vertical
  stack.alignment = .leading
  stack.spacing = 4
  return stack
}

extension ISO8601DateFormatter {
  static var fractional: ISO8601DateFormatter {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }
}

func validNamespace(_ namespace: String, _ generation: String) -> Bool {
  if namespace == "diagnostic" { return generation.hasPrefix("test-") && generation.count <= 240 }
  return namespace == "production" && generation.hasPrefix("g-") && generation.count <= 240
}

func noticeID(_ namespace: String, _ generation: String) -> String {
  "\(noticeIdentifier).\(namespace).\(generation)"
}

// Shared for this process's complete lifetime. The installer takes the same
// permanent inode exclusively after marking maintenance and draining entrants.
// The embedded token also rejects a preloaded old image scheduled only after
// replacement has completed and its maintenance marker has disappeared.
private var nativeAdmissionFD: Int32 = -1
func admitNative() -> Bool {
  let home = keeperHome()
  let marker = (home as NSString).appendingPathComponent("install-in-progress.json")
  let tokenFile = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/native-generation").path
  let validToken = { (try? String(contentsOfFile: tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)) == nativeBuildToken }
  guard !FileManager.default.fileExists(atPath: marker), validToken() else {
    emit(["ok": false, "error": "busy", "message": "The reminder helper is updating. Try again.", "nodeInvoked": false]); return false
  }
  do { try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true) } catch { return false }
  let file = (home as NSString).appendingPathComponent("native.flock")
  let fd = open(file, O_CREAT | O_RDWR, mode_t(0o600))
  guard fd >= 0 else { return false }
  guard flock(fd, LOCK_SH | LOCK_NB) == 0 else {
    close(fd); emit(["ok": false, "error": "busy", "nodeInvoked": false]); return false
  }
  guard !FileManager.default.fileExists(atPath: marker), validToken() else {
    close(fd); emit(["ok": false, "error": "busy", "nodeInvoked": false]); return false
  }
  nativeAdmissionFD = fd
  return true
}

// Real interactive actions may overlap a bounded posting invocation. Retry only
// explicit contention; every attempt still uses the durable state/generation
// checks. The overall action remains bounded below its 20-second budget.
func runNodeRetryingBusy(arguments: [String]) -> NodeRun {
  let deadline = Date().addingTimeInterval(18)
  while true {
    let remaining = deadline.timeIntervalSinceNow
    let result = runNode(arguments: arguments, timeout: max(0.1, remaining))
    if result.status != 75 || result.timedOut || Date() >= deadline
      || FileManager.default.fileExists(atPath: (keeperHome() as NSString).appendingPathComponent("install-in-progress.json")) { return result }
    Thread.sleep(forTimeInterval: 0.1)
  }
}
