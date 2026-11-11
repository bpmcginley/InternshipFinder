"""Public site origin and the exact generated-page stylesheet."""

SITE = "https://internscout.org"
SLOGAN = "Built by one student, made for all students."


CSS = """
@font-face{font-family:"IBM Plex Sans";src:url(/fonts/ibm-plex-sans-latin.woff2) format("woff2");font-weight:100 700;font-style:normal;font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Source Serif 4";src:url(/fonts/source-serif-4-latin.woff2) format("woff2");font-weight:600;font-style:normal;font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Plex Fallback";src:local("Arial"),local("ArialMT"),local("Helvetica Neue"),local("Helvetica"),local("Roboto");font-weight:400;size-adjust:100.1%;ascent-override:102.4%;descent-override:27.5%;line-gap-override:0%}
@font-face{font-family:"Plex Fallback";src:local("Arial"),local("ArialMT"),local("Helvetica Neue"),local("Helvetica"),local("Roboto");font-weight:500;size-adjust:102.1%;ascent-override:100.4%;descent-override:26.9%;line-gap-override:0%}
@font-face{font-family:"Plex Fallback";src:local("Arial Bold"),local("Arial-BoldMT"),local("Helvetica Neue Bold"),local("Helvetica Bold"),local("Roboto Bold");font-weight:600 700;size-adjust:97.2%;ascent-override:105.5%;descent-override:28.3%;line-gap-override:0%}
@font-face{font-family:"Serif Fallback";src:local("Georgia Bold"),local("Georgia-Bold");font-weight:600 700;size-adjust:86%;ascent-override:120.5%;descent-override:39%;line-gap-override:0%}
:root{--paper:#f6f4ef;--panel:#fffefb;--sunk:#efece5;--ink:#17191c;--ink2:#454a52;--ink3:#646a73;--rule:#e2ded4;--rule2:#ece9e1;--field-border:#80858c;--accent:#1d5c46;--accent-ink:#fff;--accent-hover:#164a38;--accent-soft:#e3eee8;--blue:#2b5aa0;--amber:#8c5a0f;--amber-soft:#f6ecd9;--green:#1d7549;--red:#a8362c;
--serif:"Source Serif 4","Serif Fallback",Georgia,"Times New Roman",serif;--sans:"IBM Plex Sans","Plex Fallback",system-ui,-apple-system,"Segoe UI",sans-serif;--fs-1:12px;--fs-2:13px;--fs-3:15px;--fs-4:16px;--fs-5:18px;--fs-6:22px;--fs-7:28px;--fs-8:34px;--lh:1.5;--lh-head:1.2;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px;--r-sm:4px;--r:6px;--r-lg:8px;--r-pill:999px;--shadow-pop:0 10px 30px color-mix(in srgb,var(--ink) 14%,transparent);--ring:0 0 0 1px var(--accent);--h-ctl:36px;--h-ctl-sm:32px;--h-field:40px;--ease-out:cubic-bezier(.2,.7,.3,1);--t-fast:140ms;--t-move:200ms;--i-chevron:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");--i-search:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='M20 20l-4-4'/%3E%3C/svg%3E");--i-check:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7'/%3E%3C/svg%3E");--i-cross:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 6l12 12M18 6L6 18'/%3E%3C/svg%3E");--i-alert:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M12 7.5v5.5M12 16.5v.01'/%3E%3C/svg%3E");--i-external:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'/%3E%3C/svg%3E");--i-select:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23646a73' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#131416;--panel:#1a1b1e;--sunk:#232427;--ink:#ecebe6;--ink2:#b8b6af;--ink3:#95948e;--rule:#2c2d31;--rule2:#232427;--field-border:#6e7077;--accent:#7cc3a1;--accent-ink:#0f1a15;--accent-hover:#95d2b3;--accent-soft:#1c2a24;--blue:#8fb2e8;--amber:#e0b25e;--amber-soft:#2e2717;--green:#7cc3a1;--red:#e48a80;
--i-select:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2395948e' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");color-scheme:dark}}
@media (pointer:coarse){:root{--h-ctl:44px;--h-ctl-sm:44px;--h-field:44px}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);
font:var(--fs-4)/var(--lh) var(--sans)}
.wrap{max-width:860px;margin:0 auto;padding:0 20px 64px}a{color:var(--accent)}
header{display:flex;justify-content:space-between;align-items:baseline;gap:8px 20px;flex-wrap:wrap;
padding:22px 0 14px;border-bottom:1px solid var(--ink)}
.mark{font:600 var(--fs-6)/1 var(--serif);color:var(--ink);text-decoration:none}
nav{display:flex;gap:4px 14px;flex-wrap:wrap}
nav a{color:var(--ink2);font-size:var(--fs-3);text-decoration:none;transition:color 140ms ease-out}nav a:hover{color:var(--ink)}
.mobile-digest{display:none}
@media(max-width:560px){header nav{gap:4px 14px}header nav a{display:inline-flex;align-items:center;min-height:44px}header nav .nav-extra{display:none}.mobile-digest{display:inline}}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.crumbs{font-size:var(--fs-3);color:var(--ink3);margin:22px 0 0}.crumbs a{color:var(--ink3)}
h1{font:600 var(--fs-8)/1.2 var(--serif);margin:10px 0 8px}
.lede{color:var(--ink2);font-size:var(--fs-5);margin:0 0 6px}.updated{color:var(--ink3);font-size:var(--fs-3);margin:0}
.cta{display:inline-flex;align-items:center;justify-content:center;min-height:var(--h-ctl);margin:18px 0 8px;padding:10px 16px;
border-radius:var(--r);border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font-weight:600;text-decoration:none;
transition:background-color 140ms ease-out,border-color 140ms ease-out}
.cta:hover{background:var(--accent-hover);border-color:var(--accent-hover)}.cta:active{transform:translateY(1px)}
.cta.secondary{background:var(--panel);border-color:var(--field-border);color:var(--ink)}
.cta.secondary:hover{background:var(--panel);border-color:var(--ink3)}
.cta.quiet{background:transparent;border-color:transparent;color:var(--accent);padding-left:4px;padding-right:4px}
.cta.quiet:hover{text-decoration:underline;text-underline-offset:3px}
.cta[disabled],.cta[aria-disabled=true]{background:var(--sunk);border-color:var(--field-border);color:var(--ink3);cursor:default;transform:none}
ul.jobs{list-style:none;padding:0;margin:24px 0;border-top:1px solid var(--rule)}
.job{display:grid;grid-template-columns:1fr auto;gap:2px 16px;padding:14px 0;border-bottom:1px solid var(--rule)}
.co{font-weight:600}.co a{color:var(--ink);text-decoration:none}.co a:hover{text-decoration:underline;text-underline-offset:3px}.role{grid-column:1}.meta{grid-column:1;color:var(--ink3);font-size:var(--fs-3)}
.pay{color:var(--ink2);font-variant-numeric:tabular-nums}.new{font-size:var(--fs-1);color:var(--accent);font-weight:600;margin-left:6px}
.acts{grid-column:2;grid-row:1/span 3;align-self:center;display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2) var(--s3)}
.go{display:inline-flex;align-items:center;min-height:var(--h-ctl);padding:0 14px;border:1px solid var(--field-border);border-radius:var(--r);
background:var(--panel);color:var(--ink);font-size:var(--fs-3);font-weight:500;text-decoration:none;white-space:nowrap;transition:border-color 140ms ease-out}
.go:hover{border-color:var(--ink3)}
.more,.follow{color:var(--ink2)}section.rel h2{font:600 var(--fs-6)/1.3 var(--serif);margin:36px 0 8px}
section.rel ul{list-style:none;padding:0;margin:0;columns:2;column-gap:28px}
section.rel li{padding:3px 0;break-inside:avoid}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:20px 0 24px;padding:16px 18px;
background:var(--panel);border:1px solid var(--rule);border-radius:var(--r-lg)}.facts dt{color:var(--ink3)}.facts dd{margin:0}
section.faq h2{font:600 var(--fs-5)/1.3 var(--serif);margin:28px 0 6px}section.faq p{margin:0;color:var(--ink2)}
@media (max-width:560px){.facts{grid-template-columns:1fr;gap:2px}.facts dd{margin-bottom:8px}}.n{color:var(--ink3);font-size:var(--fs-2)}
footer{margin-top:48px;padding-top:16px;border-top:1px solid var(--rule);color:var(--ink3);font-size:var(--fs-3)}
footer a{color:var(--ink2)}
.distribution-links{gap:8px 24px;margin-bottom:16px}
.distribution-links a,.widget-follow a{display:inline-flex;align-items:center;min-height:44px;text-decoration:underline;text-underline-offset:3px}
@media (max-width:560px){h1{font-size:var(--fs-7)}section.rel ul{columns:1}
.job{grid-template-columns:1fr}.acts{grid-column:1;grid-row:auto;margin-top:var(--s2)}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}.cta:active{transform:none}}
.tablewrap{overflow-x:auto;margin:16px 0 8px}table.data{width:100%;border-collapse:collapse;font-size:var(--fs-3)}
table.data th,table.data td{text-align:left;vertical-align:top;padding:9px 14px 9px 0;border-bottom:1px solid var(--rule)}
table.data thead th{border-bottom:1px solid var(--ink);font-weight:600}table.data td.num{white-space:nowrap}
section.prose h2{font:600 var(--fs-6)/1.3 var(--serif);margin:34px 0 6px}.src{color:var(--ink3);font-size:var(--fs-3)}
table.cmp{min-width:620px}@media (max-width:560px){table.data{font-size:var(--fs-3)}table.data th,table.data td{padding-right:10px}}
table.tracker tbody th{font-weight:400}.cell-label{display:none}
@media(max-width:560px){
table.data,table.data tbody{display:block;min-width:0;width:100%}
table.data thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
table.data tbody tr{display:block;padding:12px 0;border-bottom:1px solid var(--rule)}
table.data tbody th{display:block;padding:0 0 8px;border:0;font-weight:600;overflow-wrap:anywhere}
table.data tbody td{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;padding:4px 0;border:0;white-space:normal;overflow-wrap:anywhere}
.cell-label{display:block;color:var(--ink3);font-weight:500}.cell-value{min-width:0}
}
.aa-card{margin:18px 0 0;padding:14px 18px 6px;background:var(--panel);border:1px solid var(--rule);border-radius:var(--r-lg)}
.aa-card p{margin:0;color:var(--ink2)}.aa-card .cta{margin:10px 0 8px}
figure.chart{margin:8px 0 18px}figure.chart img{display:block;max-width:100%;height:auto}
figure.chart figcaption{color:var(--ink3);font-size:var(--fs-3);margin-top:4px}
.ext-touch{display:none}@media (pointer:coarse) and (hover:none){.ext-desk{display:none}.ext-touch{display:inline-block}}
.aa{display:inline-flex;align-items:center;min-height:var(--h-ctl);font-size:var(--fs-2);font-weight:500;color:var(--accent);text-decoration:none;white-space:nowrap}
.aa:hover{text-decoration:underline;text-underline-offset:3px}
@media (max-width:560px){.go,.aa{min-height:44px}}
main>h1:first-child{margin-top:var(--s6)}.vh{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:26px 0 6px}
.tier{position:relative;display:flex;flex-direction:column;padding:20px 18px 16px;background:var(--panel);
border:1px solid var(--rule);border-radius:var(--r-lg)}.tier.pick{border-color:var(--accent);box-shadow:var(--ring)}
.tier h2{font:600 var(--fs-6)/1.2 var(--serif);margin:0}
.tier .price{font:600 var(--fs-7)/1.1 var(--serif);margin:8px 0 2px}
.tier .price span{font:var(--fs-3)/1 var(--sans);color:var(--ink3)}
.tier .blurb{color:var(--ink2);margin:0 0 10px;font-size:var(--fs-3)}
.tier ul{margin:0 0 14px;padding-left:18px;color:var(--ink2);font-size:var(--fs-3);flex:1}.tier li{margin:4px 0}
.tier .cta{margin:0;text-align:center}
.badge{position:absolute;top:-11px;left:16px;background:var(--accent);color:var(--accent-ink);font-size:var(--fs-1);
font-weight:600;padding:3px 9px;border-radius:var(--r-pill)}
.anchor{font-size:var(--fs-5);margin:20px 0 0}ul.plain{padding-left:18px;color:var(--ink2)}ul.plain li{margin:6px 0}
@media (max-width:720px){.tiers{grid-template-columns:1fr}}
form.digest{margin:28px 0 8px;padding:16px 18px;background:var(--panel);border:1px solid var(--rule);border-radius:var(--r-lg)}
form.digest h2{font:600 var(--fs-6)/1.3 var(--serif);margin:0 0 6px}form.digest p{margin:0 0 8px;color:var(--ink2)}
.check{display:flex;gap:8px;align-items:baseline;color:var(--ink2);font-size:var(--fs-3);margin:10px 0 0}
.digest-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:12px 0 10px}.digest-row label{font-weight:600}
.digest-row input{flex:1 1 220px;min-width:0;max-width:340px;height:var(--h-field);padding:0 10px;border:1px solid var(--field-border);
border-radius:var(--r);background:var(--paper);color:var(--ink);font:inherit}
.digest-row .cta{margin:0;border:0;font:inherit;font-weight:600;cursor:pointer}form.digest .fine{font-size:var(--fs-3);color:var(--ink3);margin:0}
.i{display:inline-block;width:1em;height:1em;flex:none;vertical-align:-.125em;background:currentColor;-webkit-mask:var(--i) center/contain no-repeat;mask:var(--i) center/contain no-repeat}
.i-chevron{--i:var(--i-chevron)}.i-search{--i:var(--i-search)}.i-check{--i:var(--i-check)}.i-cross{--i:var(--i-cross)}.i-alert{--i:var(--i-alert)}.i-external{--i:var(--i-external)}
input[aria-invalid=true],textarea[aria-invalid=true],select[aria-invalid=true]{border-color:var(--red)}.field-err{color:var(--red);font-size:var(--fs-2);margin:var(--s1) 0 0}
input:disabled,select:disabled,textarea:disabled{color:var(--ink3);background-color:var(--sunk);cursor:default}
.paid{display:grid;grid-template-columns:1fr auto;gap:2px 16px;margin:var(--s3) 0;padding:var(--s3) var(--s4);background:var(--panel);border:1px solid var(--rule);border-radius:var(--r-lg)}
.paid-h{grid-column:1/-1;margin:0 0 var(--s1);font-size:var(--fs-2);font-weight:600;color:var(--ink2)}.paid-h a{margin-left:var(--s2);font-weight:400;color:var(--ink3)}
.ad{display:inline-block;margin-right:var(--s1);padding:0 6px;border:1px solid var(--ink3);border-radius:var(--r-sm);font-size:var(--fs-1);font-weight:600;line-height:18px;color:var(--ink2);vertical-align:1px}
.paid .go{grid-column:2;grid-row:2/span 3;align-self:center}@media (max-width:560px){.paid{grid-template-columns:1fr}.paid .go{grid-column:1;grid-row:auto;justify-self:start;margin-top:var(--s2)}}
"""
