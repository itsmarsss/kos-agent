#if os(iOS)
  import UIKit

  /// The edge swipe back, kept with the system's bar hidden: each page draws its own head (PageHead), and hiding the
  /// bar would otherwise take the swipe with it.
  extension UINavigationController: UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
      super.viewDidLoad()
      interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
      viewControllers.count > 1
    }
  }
#endif
