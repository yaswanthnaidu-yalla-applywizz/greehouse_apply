# UI/UX Design Specification — Greenhouse Operator Dashboard V1

## 1. Design Overview & Layout Architecture

The V1 Operator Dashboard provides a responsive desktop/tablet split-screen interface built in React Native / Web.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ 🟢 Greenhouse Application Automation Dashboard           [ Upload CSV ] [ Scan Status: 100% ]│
├───────────────────────────────┬─────────────────────────────────────────────────────────────┤
│ 📋 Candidates (12)            │ 👤 Candidate: Sai Palutla (AWL-36144)                        │
│ [ 🔍 Search Candidate / AWL ] │ 📄 Master Resume: [ Attached: AWL-36144_resume.pdf ]        │
├───────────────────────────────┼─────────────────────────────────────────────────────────────┤
│ ▶ AWL-36144 · Sai Palutla     │ Jobs Queue: [ All (5) ] [ Ready (4) ] [ Expired (1) ]        │
│   4 Jobs · 🟢 Ready           ├─────────────────────────────────────────────────────────────┤
│                               │ 🏢 DoorDash — Senior Frontend Engineer                      │
│ ▶ AWL-28737 · Sai Lokesh      │ 🔗 https://job-boards.greenhouse.io/doordashusa/jobs/7990832│
│   2 Jobs · 🟢 Ready           ├─────────────────────────────────────────────────────────────┤
│                               │ 📝 Scanned Form Questions & Tagged Answers:                 │
│ ▶ AWL-32063 · Sarada Gopu     │                                                             │
│   6 Jobs · 🟢 Ready           │ 1. First Name *                                             │
│                               │    [ Sai                      ] [ 🟢 supabase ]             │
│ ▶ AWL-25981 · Sai Prapulla    │                                                             │
│   3 Jobs · 🟢 Ready           │ 2. Last Name *                                              │
│                               │    [ Palutla                  ] [ 🟢 supabase ]             │
│                               │                                                             │
│                               │ 3. Email *                                                  │
│                               │    [ sai.palutla@example.com  ] [ 🟢 supabase ]             │
│                               │                                                             │
│                               │ 4. Are you legally authorized to work in the US? *          │
│                               │    (•) Yes  ( ) No              [ 🟢 supabase ]             │
│                               │                                                             │
│                               │ 5. Why are you interested in joining DoorDash? *            │
│                               │    ┌──────────────────────────────────────────────────┐     │
│                               │    │ I am passionate about building resilient high-   │     │
│                               │    │ scale frontend web applications...               │     │
│                               │    └──────────────────────────────────────────────────┘     │
│                               │    [ 🟣 ai ]                                                │
└───────────────────────────────┴─────────────────────────────────────────────────────────────┘
```

---

## 2. Component Breakdown

### 2.1 Ingestion & Stats Header
- **CSV Dropzone / Ingestion Button:** Allows selecting `greenhouse_only_applywizz_prod(in).csv`.
- **Metrics Bar:**
  - Total CSV Rows parsed (e.g. `142`)
  - Unique Candidates (`Applywizz ID`s) (e.g. `28`)
  - Unique Scanned Job URLs (e.g. `45`)
  - Duplicate URLs avoided (e.g. `97 saved scans`)
- **Status Indicator:** `Idle` · `Scanning Unique Links` · `Syncing Candidates` · `Ready`.

### 2.2 Left Pane: Candidate Directory
- **Search Bar:** Real-time filter by Candidate Name or `Applywizz ID`.
- **Candidate Card Item:**
  - `Applywizz ID` badge (e.g. `AWL-36144`).
  - Full Name (e.g. `Sai Palutla`).
  - Total assigned jobs pill (e.g. `4 Jobs`).
  - Status badge: `Ready for Review` | `Processing` | `Has Expired Jobs`.
  - Active selection highlight (bold outline / accent background).

### 2.3 Right Pane: Candidate Application & Q&A Viewer
- **Candidate Header:**
  - Candidate Name, Email, Phone, and Location.
  - Resume indicator with clickable preview link (`AWL-36144_resume.pdf`).
- **Jobs Navigation Tabs:** Horizontal selector for the candidate's assigned job links.
  - Shows Company Name, Job Title, and Status.
- **Dynamic Form Renderer:**
  - Displays all scanned fields extracted from the Greenhouse page.
  - **Standard Text / Number Inputs:** Pre-populated with candidate profile data.
  - **Textareas:** Pre-populated with LLM-synthesized responses for open questions.
  - **Dropdowns / Selects (`<select>`):** Displays selected value matching candidate profile/visa options.
  - **Radio Groups / Checkboxes:** Renders radio/checkbox with the resolved option active.
- **Source Badges:**
  - 🟢 **`supabase`** — Green badge indicating data resolved from candidate profile or stored database tables.
  - 🟣 **`ai`** — Purple badge indicating dynamic answer generated by LLM.

---

## 3. Visual Styling & Color Palette

| Element | Color / Token | Styling Details |
| :--- | :--- | :--- |
| **Background** | `#0F172A` (Slate 900) / `#F8FAFC` | Clean dark/light modern UI with high contrast. |
| **Card Surface** | `#1E293B` / `#FFFFFF` | Rounded corners (`border-radius: 8px`), subtle shadow. |
| **`supabase` Tag** | `#10B981` (Emerald Green) | Pill badge with emerald border and text. |
| **`ai` Tag** | `#8B5CF6` (Purple) | Pill badge with violet border and text. |
| **Primary Accent** | `#3B82F6` (Blue) | Active tabs, borders, and selection highlights. |
| **Required Star** | `#EF4444` (Red) | Asterisk indicator for mandatory fields. |

---

## 4. State Transitions & Interactions

- **Initial Load:** Displays empty state with prompt to load/parse the input CSV.
- **Processing State:** Shows progress bars for Branch 1 (Unique Link Playwright Scan) and Branch 2 (ApplyWizz API Sync & Answer Resolution).
- **Candidate Selection:** Clicking any candidate in the left pane instantly updates the right pane with that candidate's jobs and populated forms.
- **Job Tab Switching:** Switching job tabs within a candidate's queue instantly re-renders the respective scanned form questions and tagged answers.
