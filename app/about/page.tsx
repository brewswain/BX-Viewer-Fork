import type { Metadata } from 'next'
import SiteHeader from '@/components/SiteHeader'

export const metadata: Metadata = {
  title: 'About — BounceX Viewer',
}

export default function AboutPage() {
  return (
    <>
      <SiteHeader active="about" />

      <main className="main-content">
        <div className="about-layout">
          <div className="about-hero">
            <div className="about-logo">
              Bounce
              <span>X</span>
              Viewer
            </div>
            <p className="about-tagline">A .bx file and video player.</p>
          </div>

          <div className="about-grid">
            <div className="about-card">
              <div className="about-card-title">What is this?</div>
              <div className="about-card-body">
                <p>
                  BounceX Viewer is a web-based player for BounceX .bx files. It
                  lets you watch videos synchronized with their BounceX path data
                  in real time.
                </p>
              </div>
            </div>

            <div className="about-card">
              <div className="about-card-title">What is BounceX?</div>
              <div className="about-card-body">
                <p>
                  BounceX is a beat marker creation and rendering tool.
                  <br />
                  The accompanying paths represent the depth at which to insert a
                  dildo. When the ball reaches the top, insert all the way in, and
                  at the bottom, remove or nearly remove the dildo.
                </p>
              </div>
            </div>

            <div className="about-card">
              <div className="about-card-title">How to use</div>
              <div className="about-card-body">
                <p>
                  Use the manager page to drag and drop .zip files containing
                  packages, then hard refresh (ctrl + shift + R) to see the
                  changes and watch new videos in the browse tab!
                  <br />
                  <br />
                  For information on creating new packages, see the github page.
                </p>
              </div>
            </div>

            <div className="about-card">
              <div className="about-card-title">Disclosure</div>
              <div className="about-card-body">
                <p>
                  This site is created mostly by generative AI.
                  <br />
                  <br />
                  Charts and videos are by their respective creators.
                </p>
              </div>
            </div>

            <div className="about-card about-card-wide">
              <div className="about-card-title">Links</div>
              <div className="about-card-body">
                <div className="about-links">
                  <a href="https://discord.gg/Y8YdgmH8Ka" className="about-link">
                    <span className="about-link-label">Dildo Hero Discord</span>
                  </a>
                  <a
                    href="https://github.com/Alunacoz/BounceX-Viewer"
                    className="about-link"
                  >
                    <span className="about-link-label">GitHub</span>
                  </a>
                  <a href="https://www.patreon.com/Alunacoz" className="about-link">
                    <span className="about-link-label">Patreon</span>
                  </a>
                  <a
                    href="https://github.com/clbhundley/BounceX"
                    className="about-link"
                  >
                    <span className="about-link-label">Original BounceX Github</span>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </>
  )
}
