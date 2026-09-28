/*
 * RoboRoute Nexus project page behaviour.
 *
 * Deliberately small: the page works without JavaScript. This file only keeps the sticky
 * header height in sync with what the browser actually laid out (so anchor targets and
 * scroll padding can never end up underneath it), highlights the current section in the
 * navigation, and marks demo images once their bytes have arrived.
 */

(function () {
  'use strict';

  var root = document.documentElement;
  var header = document.querySelector('.topbar');

  /** Publish the measured header height so CSS can reserve exactly that much space. */
  function syncHeaderHeight() {
    if (!header) return;
    var height = Math.ceil(header.getBoundingClientRect().height);
    if (height > 0) {
      root.style.setProperty('--header-h', height + 'px');
    }
  }

  syncHeaderHeight();
  window.addEventListener('resize', syncHeaderHeight);
  window.addEventListener('orientationchange', syncHeaderHeight);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncHeaderHeight).catch(function () {});
  }
  // The nav wraps at some widths, so re-measure once the layout has settled.
  window.addEventListener('load', syncHeaderHeight);

  /** Highlight the navigation entry for the section the reader is looking at. */
  var links = Array.prototype.slice.call(
    document.querySelectorAll('.topbar__nav a[href^="#"]'),
  );

  if (links.length && 'IntersectionObserver' in window) {
    var byId = {};
    var targets = [];

    links.forEach(function (link) {
      var id = link.getAttribute('href').slice(1);
      var target = id ? document.getElementById(id) : null;
      if (!target) return;
      byId[id] = link;
      targets.push(target);
    });

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          links.forEach(function (link) {
            link.removeAttribute('aria-current');
            link.style.color = '';
            link.style.background = '';
          });
          var active = byId[entry.target.id];
          if (!active) return;
          active.setAttribute('aria-current', 'true');
          active.style.color = 'var(--text)';
          active.style.background = 'rgba(79, 172, 254, 0.12)';
        });
      },
      { rootMargin: '-45% 0px -50% 0px', threshold: 0 },
    );

    targets.forEach(function (target) {
      observer.observe(target);
    });
  }

  /** Let the reader replay a demo without reloading the page. */
  Array.prototype.forEach.call(document.querySelectorAll('.demo__media'), function (image) {
    image.addEventListener('load', function () {
      image.setAttribute('data-loaded', 'true');
    });

    image.addEventListener('click', function () {
      var source = image.getAttribute('src');
      var separator = source.indexOf('?') === -1 ? '?' : '&';
      // Re-requesting the same URL restarts the animation in every major browser.
      image.setAttribute('src', source + separator + 'replay=' + Date.now());
    });
  });
})();
