const BOARD_TITLES = {
  weekly: "Tasks Completed Per Week",
  weekdays: "Busiest Weekdays",
  perPerson: "Chores Per Person",
  perPersonFinished: "Chores Per Person (Finished)",
  perPersonFinishedWeek: "Chores Per Person (Finished This Week)",
  perPersonUnfinished: "Chores Per Person (Unfinished)",
  perPersonUnfinishedWeek: "Chores Per Person (Unfinished This Week)",
  taskmaster: "Taskmaster This Month",
  lazyLegends: "Lazy Legends",
  speedDemons: "Speed Demons",
  weekendWarriors: "Weekend Warriors",
  slacker9000: "Slacker Detector 9000"
};

Module.register("MMM-Chores", {
  defaults: {
    updateInterval: 60 * 1000,
    adminPort: 5003,
    settings: "locked", // set to "unlocked" to enable settings popup or to a 6-digit PIN (e.g. "000000") to require a PIN
    showDays: 1,
    showPast: false,
    dateFormatting: "yyyy-mm-dd", // Standardformat, kan ändras i config
    textMirrorSize: "small",     // small, medium or large
    useAI: true,                  // hide AI features when false
    openaiApiKey: "",
    pushoverApiKey: "",
    pushoverUser: "",
    pushoverEnabled: false,
    reminderTime: "",
    login: false,
    users: [],
    showAnalyticsOnMirror: false, // display analytics cards on the mirror
    analyticsCards: [],           // board types selected in the admin UI
    showCoinsOnMirror: true,      // display coin balances next to assignees when coin system is active
    showLevelOnMirror: true,      // display level badge next to assignees when level system is active
    showRedeemedRewards: true,    // display redeemed rewards on mirror above chores when coin system is active
    usePointSystem: false,        // use point system instead of level system
    leveling: {
      enabled: true,
      mode: "years",
      yearsToMaxLevel: 3,
      choresPerWeekEstimate: 4,
      choresToMaxLevel: 0
    },
    levelTitles: [
      "Junior",
      "Apprentice",
      "Journeyman",
      "Experienced",
      "Expert",
      "Veteran",
      "Master",
      "Grandmaster",
      "Legend",
      "Mythic"
    ],
    customLevelTitles: {},
    voiceAssistant: {
      enabled: false,
      language: null,          // null = derive from module language (en->en-US, sv->sv-SE, etc.)
      continuous: false,
      interimResults: false,
      maxAlternatives: 1,
      ttsEnabled: true,
      ttsVoice: "default",
      ttsRate: 1.0,
      ttsPitch: 1.0,
      showTranscription: true,
      wakeWord: null  // Optional wake word like "hey chores"
    },
    ttsAudio: {
      volume: 0.7,
      pauseMs: 600,
      fadeMs: 120
    },
    splitByPerson: false,  // Split chores view into separate columns per person
    personColors: {}       // Optional: map person names to colors for column headers
  },

  start() {
    this.tasks = [];
    this.allTasks = [];
    this.people = [];
    this.redemptions = [];
    this.levelInfo = null;
    this.chartInstances = {};
    this.voiceRecognition = null;
    this.isListening = false;
    this.lastTranscript = "";
    this.sendSocketNotification("INIT_SERVER", this.config);
    this.scheduleUpdate();
    if (this.config.voiceAssistant && this.config.voiceAssistant.enabled) {
      this.initVoiceRecognition();
    }
  },

  getStyles() {
    return ["MMM-Chores.css"];
  },

  getScripts() {
    if (this.config.showAnalyticsOnMirror) {
      return [
        "https://cdn.jsdelivr.net/npm/chart.js@4.3.0/dist/chart.umd.min.js"
      ];
    }
    return [];
  },

  scheduleUpdate() {
    if (this.config.showAnalyticsOnMirror) {
      // Avoid refreshing the entire DOM while analytics charts are visible to
      // prevent a flashing effect. Updates instead come from socket
      // notifications when data changes.
      return;
    }
    setInterval(() => this.updateDom(), this.config.updateInterval);
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "TASKS_UPDATE") {
      this.allTasks = payload;
      this.updateDom();
    }
    if (notification === "CHORES_DATA") {
      this.tasks = payload;
      this.updateDom();
    }
    if (notification === "REDEMPTIONS_UPDATE") {
      this.redemptions = Array.isArray(payload) ? payload : [];
      this.updateDom();
    }
    if (notification === "PEOPLE_UPDATE") {
      this.people = payload;
      this.updateDom();
    }
    if (notification === "SETTINGS_UPDATE") {
      const prevAnalytics = this.config.showAnalyticsOnMirror;
      // Object.assign(this.config, payload);
      this.config = {...payload, ...this.config};
      if (payload.levelingEnabled !== undefined) {
        this.config.leveling = this.config.leveling || {};
        this.config.leveling.enabled = payload.levelingEnabled;
      }
      if (payload.usePointSystem !== undefined) {
        this.config.usePointSystem = payload.usePointSystem;
      }
      if (payload.showAnalyticsOnMirror && !prevAnalytics && typeof Chart === "undefined") {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/chart.js@4.3.0/dist/chart.umd.min.js";
        script.onload = () => this.updateDom();
        document.head.appendChild(script);
      } else {
        this.updateDom();
      }
    }
    if (notification === "ANALYTICS_UPDATE") {
      if (Array.isArray(payload)) {
        this.config.analyticsCards = payload;
        this.updateDom();
      }
    }
    if (notification === "LEVEL_INFO") {
      const prevTitle = this.levelInfo ? this.levelInfo.title : null;
      this.levelInfo = payload;
      if (prevTitle && prevTitle !== payload.title) {
        this.titleChangeMessage = `Congrats! You advanced from ${prevTitle} to ${payload.title}!`;
        setTimeout(() => { this.titleChangeMessage = null; this.updateDom(); }, 5000);
      }
      this.updateDom();
    }
    if (notification === "PUSHOVER_CONFIG_ERROR") {
      this.sendNotification("SHOW_ALERT", {
        type: "notification",
        title: "MMM-Chores",
        message: payload || "Please set pushoverApiKey and pushoverUser in config.js to use Pushover notifications."
      });
    }
    if (notification === "VOICE_RESPONSE") {
      if (this.config.voiceAssistant && this.config.voiceAssistant.ttsEnabled) {
        this.speakResponse(payload.text);
      }
      if (payload.action) {
        this.handleVoiceAction(payload.action);
      }
    }
  },

  shouldShowTask(task) {
    const showDays = parseInt(this.config.showDays, 10);
    const showPast = Boolean(this.config.showPast);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Parse the task's date as a local date to avoid timezone shifts that
    // make today's chores appear as past tasks in some regions.
    let tDate;
    if (typeof task.date === "string") {
      const parts = task.date.split("-").map(Number);
      if (parts.length === 3) {
        tDate = new Date(parts[0], parts[1] - 1, parts[2]);
      } else {
        tDate = new Date(task.date);
      }
    } else {
      tDate = new Date(task.date);
    }
    tDate.setHours(0, 0, 0, 0);

    const diffMs = tDate - today;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      // Task is in the past. Respect the showPast setting and only display
      // unfinished tasks when enabled. Completed past tasks are always hidden.
      if (!showPast) return false;
      return !task.done;
    }
    return diffDays < showDays;
  },

  getPersonName(id) {
    const p = this.people.find(p => p.id === id);
    return p ? p.name : "";
  },

  getPerson(id) {
    return this.people.find(p => p.id === id) || null;
  },

  toggleDone(task, done) {
    this.sendSocketNotification("USER_TOGGLE_CHORE", {
      id: task.id,
      done,
      occurrenceDate: task.occurrenceDate || task.date
    });
  },

  showCelebration(element) {
    // Create full-screen celebration overlay
    const celebration = document.createElement("div");
    celebration.className = "chore-celebration";

    // Create more confetti pieces for full screen effect
    for (let i = 0; i < 30; i++) {
      const confetti = document.createElement("div");
      confetti.className = "confetti";

      // Random colors from family palette
      const colors = ["#e74c3c", "#f39c12", "#2ecc71", "#4a90e2", "#9b59b6", "#ffd93d"];
      confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];

      // Random horizontal position across the screen
      confetti.style.left = Math.random() * 100 + "%";

      // Random animation delay and duration
      confetti.style.animationDelay = Math.random() * 0.5 + "s";
      confetti.style.animationDuration = (Math.random() * 0.5 + 1.5) + "s";

      celebration.appendChild(confetti);
    }

    // Add multiple icon bursts
    const celebrationIcons = ["party-popper.svg", "star.svg", "sparkles.svg", "glowing-star.svg", "dizzy-star.svg"];
    for (let i = 0; i < 3; i++) {
      const icon = document.createElement("img");
      icon.className = "celebration-icon";
      icon.src = this.file(`img/celebration/${celebrationIcons[Math.floor(Math.random() * celebrationIcons.length)]}`);
      icon.alt = "";
      icon.setAttribute("aria-hidden", "true");
      icon.style.left = (20 + Math.random() * 60) + "%";
      icon.style.top = (30 + Math.random() * 40) + "%";
      icon.style.animationDelay = (i * 0.3) + "s";
      celebration.appendChild(icon);
    }

    // Add to body for full-screen effect
    document.body.appendChild(celebration);

    // Remove after animation
    setTimeout(() => {
      celebration.remove();
    }, 2000);
  },

  handleVoiceAction(action) {
    if (action.type === "TOGGLE_TASK" && action.taskId) {
      const task = this.tasks.find(t => t.id === action.taskId);
      if (task) {
        this.toggleDone(task, action.done);
      }
    }
    // Additional actions can be handled here
  },

  formatDate(dateStr) {
    if (!dateStr) return "";
    const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return dateStr;
    const [ , yyyy, mm, dd ] = match;

    // Use module config for formatting. If set to empty string, hide the date
    // entirely. Only fall back to the default when no value is specified.
    let result =
      this.config.dateFormatting !== undefined &&
      this.config.dateFormatting !== null
        ? this.config.dateFormatting
        : "yyyy-mm-dd";

    if (result === "") return "";

    if (result === "D") {
      const date = new Date(yyyy, mm - 1, dd);
      const day = date.getDay();
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      return "(" + days[day] + ")";
    }

    // Ersätt både små och stora bokstäver för yyyy, mm, dd
    result = result.replace(/yyyy/gi, yyyy);
    result = result.replace(/mm/gi, mm);
    result = result.replace(/dd/gi, dd);

    // Extra stöd för stora bokstäver som kan missas pga regex
    // (Om användaren skriver t.ex "DD" istället för "dd")
    result = result.replace(/YYYY/g, yyyy);
    result = result.replace(/MM/g, mm);
    result = result.replace(/DD/g, dd);

    return result;
  },

  buildChartData(type) {
    const source = Array.isArray(this.allTasks) && this.allTasks.length ? this.allTasks : this.tasks;
    const filteredTasks = fn => source.filter(t => !(t.deleted && !t.done) && fn(t));
    let data = { labels: [], datasets: [] };
    let options = { scales: { y: { beginAtZero: true } } };
    let chartType = "bar";

    switch (type) {
      case "weekly": {
        const today = new Date();
        const labels = [];
        const counts = [];
        for (let i = 3; i >= 0; i--) {
          const d = new Date(today);
          d.setDate(today.getDate() - i * 7);
          labels.push(d.toISOString().split("T")[0]);
          const c = filteredTasks(t => {
            const td = new Date(t.date);
            return t.done && ((today - td) / 86400000) >= i * 7 && ((today - td) / 86400000) < (i + 1) * 7;
          }).length;
          counts.push(c);
        }
        data = { labels, datasets: [{ label: "Completed Tasks", data: counts, backgroundColor: "rgba(75,192,192,0.5)" }] };
        break;
      }
      case "weekdays": {
        chartType = "pie";
        const labels = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
        const arr = [0,0,0,0,0,0,0];
        filteredTasks(t => true).forEach(t => {
          const idx = (new Date(t.date).getDay() + 6) % 7;
          arr[idx]++;
        });
        data = {
          labels,
          datasets: [{ data: arr, backgroundColor: ["#FF6384","#36A2EB","#FFCE56","#4BC0C0","#9966FF","#FF9F40","#C9CBCF"] }]
        };
        options = {};
        break;
      }
      case "perPerson": {
        const labels = this.people.map(p => p.name);
        const counts = this.people.map(p => filteredTasks(t => t.assignedTo === p.id).length);
        data = { labels, datasets: [{ label: "Finished Tasks", data: counts, backgroundColor: "rgba(153,102,255,0.5)" }] };
        break;
      }
      case "perPersonFinished": {
        const labels = this.people.map(p => p.name);
        const counts = this.people.map(p => filteredTasks(t => t.assignedTo === p.id && t.done).length);
        data = { labels, datasets: [{ label: BOARD_TITLES.perPersonFinished, data: counts, backgroundColor: "rgba(75,192,192,0.5)" }] };
        break;
      }
      case "perPersonFinishedWeek": {
        const now = new Date();
        const start = new Date(now);
        start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(start.getDate() + 7);
        const labels = this.people.map(p => p.name);
        const counts = this.people.map(p =>
          filteredTasks(t => {
            if (!t.done || t.assignedTo !== p.id) return false;
            const d = new Date(t.date);
            return d >= start && d < end;
          }).length
        );
        data = { labels, datasets: [{ label: BOARD_TITLES.perPersonFinishedWeek, data: counts, backgroundColor: "rgba(75,192,192,0.5)" }] };
        break;
      }
      case "perPersonUnfinished": {
        const labels = this.people.map(p => p.name);
        const counts = this.people.map(p => filteredTasks(t => t.assignedTo === p.id && !t.done).length);
        data = { labels, datasets: [{ label: BOARD_TITLES.perPersonUnfinished, data: counts, backgroundColor: "rgba(255,99,132,0.5)" }] };
        break;
      }
      case "perPersonUnfinishedWeek": {
        const now = new Date();
        const start = new Date(now);
        start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(start.getDate() + 7);
        const labels = this.people.map(p => p.name);
        const counts = this.people.map(p =>
          filteredTasks(t => {
            if (t.done || t.assignedTo !== p.id) return false;
            const d = new Date(t.date);
            return d >= start && d < end;
          }).length
        );
        data = { labels, datasets: [{ label: BOARD_TITLES.perPersonUnfinishedWeek, data: counts, backgroundColor: "rgba(255,99,132,0.5)" }] };
        break;
      }
      case "taskmaster": {
        const now = new Date();
        const labels = this.people.map(p => p.name);
        const counts = this.people.map(p => source.filter(t => {
          const d = new Date(t.date);
          return t.done && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear() && t.assignedTo === p.id;
        }).length);
        data = { labels, datasets: [{ label: BOARD_TITLES.taskmaster, data: counts, backgroundColor: "rgba(255,159,64,0.5)" }] };
        break;
      }
      case "lazyLegends": {
        const labels = this.people.map(p => p.name);
        const counts = this.people.map(p => filteredTasks(t => t.assignedTo === p.id && !t.done).length);
        data = { labels, datasets: [{ label: BOARD_TITLES.lazyLegends, data: counts, backgroundColor: "rgba(255,99,132,0.5)" }] };
        break;
      }
      case "speedDemons": {
        const labels = this.people.map(p => p.name);
        const avgDays = this.people.map(p => {
          const times = filteredTasks(t => t.assignedTo === p.id && t.done && t.finished && t.assignedDate).map(t => {
            const dDone = new Date(t.finished);
            const dAssigned = new Date(t.assignedDate);
            return (dDone - dAssigned) / (1000*60*60*24);
          });
          if (times.length === 0) return 0;
          return times.reduce((a,b) => a+b, 0) / times.length;
        });
        data = { labels, datasets: [{ label: BOARD_TITLES.speedDemons, data: avgDays, backgroundColor: "rgba(54,162,235,0.5)" }] };
        break;
      }
      case "weekendWarriors": {
        const labels = this.people.map(p => p.name);
        const counts = this.people.map(p => filteredTasks(t => {
          if (!t.done || t.assignedTo !== p.id) return false;
          const d = new Date(t.date);
          return d.getDay() === 0 || d.getDay() === 6;
        }).length);
        data = { labels, datasets: [{ label: BOARD_TITLES.weekendWarriors, data: counts, backgroundColor: "rgba(255,206,86,0.5)" }] };
        break;
      }
      case "slacker9000": {
        const labels = this.people.map(p => p.name);
        const ages = this.people.map(p => {
          const open = filteredTasks(t => t.assignedTo === p.id && !t.done && t.assignedDate);
          if (open.length === 0) return 0;
          const now = new Date();
          return Math.max(...open.map(t => (now - new Date(t.assignedDate)) / (1000*60*60*24)));
        });
        data = { labels, datasets: [{ label: BOARD_TITLES.slacker9000, data: ages, backgroundColor: "rgba(153,102,255,0.5)" }] };
        break;
      }
      default:
        data = { labels: [], datasets: [] };
        break;
    }

    return { chartType, data, options };
  },

  renderCharts() {
    if (!this.config.showAnalyticsOnMirror || typeof Chart === "undefined") return;

    const types = this.config.analyticsCards;
    const currentIds = [];

    types.forEach((type, idx) => {
      const id = `chart-${idx}`;
      currentIds.push(id);
      const canvas = document.getElementById(id);
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      const { chartType, data, options } = this.buildChartData(type);
      const existing = this.chartInstances[id];
      if (existing) {
        existing.destroy();
      }
      this.chartInstances[id] = new Chart(ctx, { type: chartType, data, options });
    });

    // destroy charts that are no longer configured
    Object.keys(this.chartInstances).forEach(id => {
      if (!currentIds.includes(id)) {
        this.chartInstances[id].destroy();
        delete this.chartInstances[id];
      }
    });
  },

  getRedeemedLabel() {
    const lang = (this.config.language || "en").toLowerCase();
    const labels = {
      en: "redeemed",
      sv: "löste in",
      es: "canjeó",
      fr: "a utilisé",
      de: "eingelöst",
      it: "ha riscattato",
      nl: "verzilverd",
      pl: "zrealizował",
      zh: "兑换了",
      ar: "استبدل"
    };

    // Match exact or locale-prefixed codes, default to English
    const entry = Object.entries(labels).find(([code]) => lang === code || lang.startsWith(`${code}-`));
    return entry ? entry[1] : labels.en;
  },

  resolveVoiceLocale(preferred) {
    const fallback = "en-US";
    const fromConfig = (this.config.language || "").toLowerCase();
    const preferredCode = (preferred || fromConfig || "en").toLowerCase();
    const map = {
      en: "en-US",
      sv: "sv-SE",
      es: "es-ES",
      fr: "fr-FR",
      de: "de-DE",
      it: "it-IT",
      nl: "nl-NL",
      pl: "pl-PL",
      zh: "zh-CN",
      ar: "ar-AR"
    };
    return map[preferredCode.split("-")[0]] || preferred || fallback;
  },

  initVoiceRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      Log.warn("MMM-Chores: Speech recognition not supported in this browser");
      return;
    }

    const config = this.config.voiceAssistant;
    this.voiceRecognition = new SpeechRecognition();
    this.voiceRecognition.lang = this.resolveVoiceLocale(config.language);
    this.voiceRecognition.continuous = config.continuous || false;
    this.voiceRecognition.interimResults = config.interimResults || false;
    this.voiceRecognition.maxAlternatives = config.maxAlternatives || 1;

    this.voiceRecognition.onstart = () => {
      this.isListening = true;
      this.updateDom();
    };

    this.voiceRecognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      if (result.isFinal) {
        const transcript = result[0].transcript.trim();
        this.lastTranscript = transcript;
        this.handleVoiceCommand(transcript);
      }
    };

    this.voiceRecognition.onerror = (event) => {
      Log.error("MMM-Chores: Voice recognition error", event.error);
      this.isListening = false;
      this.updateDom();
    };

    this.voiceRecognition.onend = () => {
      this.isListening = false;
      this.updateDom();
    };
  },

  startListening() {
    if (!this.voiceRecognition) {
      this.initVoiceRecognition();
    }
    if (this.voiceRecognition && !this.isListening) {
      try {
        this.voiceRecognition.start();
      } catch (err) {
        Log.error("MMM-Chores: Failed to start voice recognition", err);
      }
    }
  },

  stopListening() {
    if (this.voiceRecognition && this.isListening) {
      this.voiceRecognition.stop();
    }
  },

  handleVoiceCommand(transcript) {
    Log.log("MMM-Chores: Voice command received:", transcript);
    this.sendSocketNotification("VOICE_COMMAND", {
      transcript,
      people: this.people,
      tasks: this.tasks
    });
    this.updateDom();
  },

  speakResponse(text) {
    if (!this.config.voiceAssistant || !this.config.voiceAssistant.ttsEnabled) {
      return;
    }

    if ('speechSynthesis' in window) {
      // Cancel any ongoing speech to prevent overlap
      window.speechSynthesis.cancel();

      // Add a pause before speaking to prevent the first word from being cut off
      const cfg = this.config.ttsAudio || {};
      const pauseMs = Number.isFinite(cfg.pauseMs) ? cfg.pauseMs : 600;
      const volume = Number.isFinite(cfg.volume) ? cfg.volume : 0.7;
      const utterance = new SpeechSynthesisUtterance(text);
      const config = this.config.voiceAssistant;
      
      if (config.ttsVoice && config.ttsVoice !== 'default') {
        const voices = window.speechSynthesis.getVoices();
        const voice = voices.find(v => v.name === config.ttsVoice);
        if (voice) utterance.voice = voice;
      }
      
      utterance.rate = config.ttsRate || 1.0;
      utterance.pitch = config.ttsPitch || 1.0;
      utterance.lang = this.resolveVoiceLocale(config.language);
      utterance.volume = Math.min(Math.max(volume, 0), 1);

      // Temporarily stop recognition to prevent feedback/ducking
      const wasListening = this.isListening;
      if (this.voiceRecognition && wasListening) {
        this.voiceRecognition.abort();
        this.isListening = false;
        this.updateDom();
      }

      utterance.onend = () => {
        // No auto-restart of listening. User must press mic button.
      };
      
      // Small delay to allow mic to fully close and audio context to settle
      setTimeout(() => {
        window.speechSynthesis.speak(utterance);
      }, pauseMs);
    }
  },

  getDomSplitByPerson() {
    const wrapper = document.createElement("div");
    wrapper.className = "chores-split-view";

    // Add admin button at the top
    const adminButton = document.createElement("button");
    adminButton.className = "admin-button";
    adminButton.innerHTML = '<span class="admin-icon">⚙️</span> Admin';
    adminButton.addEventListener("click", () => {
      window.location.href = `http://localhost:${this.config.adminPort}`;
    });
    wrapper.appendChild(adminButton);

    // Filter visible tasks
    const visible = this.tasks
      .filter(t => !t.deleted && this.shouldShowTask(t))
      .sort((a, b) => {
        if (a.done && !b.done) return 1;
        if (!a.done && b.done) return -1;
        const da = new Date(a.date);
        const db = new Date(b.date);
        if (da < db) return -1;
        if (da > db) return 1;
        return (a.order || 0) - (b.order || 0);
      });

    // Group redemptions by person
    const showRedeemed = this.config.usePointSystem && this.config.showRedeemedRewards !== false;
    const pendingRedemptions = showRedeemed
      ? (this.redemptions || []).filter(r => !r.used).sort((a, b) => new Date(b.redeemed) - new Date(a.redeemed))
      : [];

    const redemptionsByPerson = {};
    pendingRedemptions.forEach(red => {
      if (red.personId) {
        if (!redemptionsByPerson[red.personId]) {
          redemptionsByPerson[red.personId] = [];
        }
        redemptionsByPerson[red.personId].push(red);
      }
    });

    if (visible.length === 0 && pendingRedemptions.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = `${this.config.textMirrorSize} dimmed`;
      emptyEl.innerHTML = "No tasks to show 🎉";
      wrapper.appendChild(emptyEl);
      return wrapper;
    }

    // Group tasks by person
    const tasksByPerson = {};
    const unassigned = [];

    visible.forEach(task => {
      if (!task.assignedTo) {
        unassigned.push(task);
      } else {
        if (!tasksByPerson[task.assignedTo]) {
          tasksByPerson[task.assignedTo] = [];
        }
        tasksByPerson[task.assignedTo].push(task);
      }
    });

    // Create columns for each person
    const columnsWrapper = document.createElement("div");
    columnsWrapper.className = "person-columns";

    this.people.forEach(person => {
      const tasks = tasksByPerson[person.id] || [];
      const redemptions = redemptionsByPerson[person.id] || [];
      if (tasks.length === 0 && redemptions.length === 0) return; // Skip people with no tasks or redemptions

      const column = document.createElement("div");
      column.className = "person-column";

      // Person header with their name and stats
      const header = document.createElement("div");
      header.className = "person-header";

      const personColor = this.config.personColors[person.name];
      if (personColor) {
        header.style.borderBottomColor = personColor;
      }

      const nameEl = document.createElement("div");
      nameEl.className = "person-name bright";
      nameEl.textContent = person.name;
      if (personColor) {
        nameEl.style.color = personColor;
      }
      header.appendChild(nameEl);

      // Show level or points
      const statsEl = document.createElement("div");
      statsEl.className = "person-stats xsmall dimmed";
      if (this.config.usePointSystem && person.points !== undefined) {
        statsEl.innerHTML = `🪙 ${person.points} coins`;
      } else if (person.level) {
        statsEl.innerHTML = `Level ${person.level} • ${person.title || ''}`;
      }
      if (statsEl.innerHTML) {
        header.appendChild(statsEl);
      }

      column.appendChild(header);

      // Task list for this person
      if (tasks.length > 0) {
        const ul = document.createElement("ul");
        ul.className = "normal";

        tasks.forEach(task => {
          const li = document.createElement("li");
          li.className = `${this.config.textMirrorSize}${task.done ? " task-done" : ""}`;

          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = task.done;
          cb.style.marginRight = "8px";
          cb.addEventListener("change", () => {
            if (cb.checked && !task.done) {
              this.showCelebration(li);
            }
            li.classList.add("moving");
            setTimeout(() => this.toggleDone(task, cb.checked), 200);
          });
          li.appendChild(cb);

          const dateText = this.formatDate(task.date);
          const text = document.createTextNode(`${task.name} ${dateText}`);
          li.appendChild(text);

          ul.appendChild(li);
        });

        column.appendChild(ul);
      }

      // Show redeemed rewards for this person (below tasks)
      if (redemptions.length > 0) {
        // Add divider between tasks and rewards if there are tasks
        if (tasks.length > 0) {
          const divider = document.createElement("hr");
          divider.className = "rewards-divider";
          column.appendChild(divider);
        }

        const rewardsSection = document.createElement("div");
        rewardsSection.className = "rewards-section";

        const rewardsHeader = document.createElement("div");
        rewardsHeader.className = "rewards-header";
        rewardsHeader.innerHTML = "🎉 Rewards! 🎉";
        rewardsSection.appendChild(rewardsHeader);

        const redemptionsUl = document.createElement("ul");
        redemptionsUl.className = "normal redemptions-list";

        redemptions.forEach(red => {
          const li = document.createElement("li");
          li.className = `${this.config.textMirrorSize} redeemed-item`;

          const emoji = document.createElement("span");
          emoji.className = "reward-emoji";
          emoji.textContent = "🎁";

          const rewardEl = document.createElement("strong");
          rewardEl.className = "reward-name";
          rewardEl.textContent = red.rewardName || "";

          const space = document.createTextNode("\u00a0");
          li.append(emoji, space, rewardEl);
          redemptionsUl.appendChild(li);
        });

        rewardsSection.appendChild(redemptionsUl);
        column.appendChild(rewardsSection);
      }

      columnsWrapper.appendChild(column);
    });

    // Add unassigned tasks if any
    if (unassigned.length > 0) {
      const column = document.createElement("div");
      column.className = "person-column";

      const header = document.createElement("div");
      header.className = "person-header";
      header.innerHTML = '<div class="person-name dimmed">Unassigned</div>';
      column.appendChild(header);

      const ul = document.createElement("ul");
      ul.className = "normal";

      unassigned.forEach(task => {
        const li = document.createElement("li");
        li.className = `${this.config.textMirrorSize}${task.done ? " task-done" : ""}`;

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = task.done;
        cb.style.marginRight = "8px";
        cb.addEventListener("change", () => {
          if (cb.checked && !task.done) {
            this.showCelebration(li);
          }
          li.classList.add("moving");
          setTimeout(() => this.toggleDone(task, cb.checked), 200);
        });
        li.appendChild(cb);

        const dateText = this.formatDate(task.date);
        const text = document.createTextNode(`${task.name} ${dateText}`);
        li.appendChild(text);

        ul.appendChild(li);
      });

      column.appendChild(ul);
      columnsWrapper.appendChild(column);
    }

    wrapper.appendChild(columnsWrapper);
    return wrapper;
  },

  getDom() {
    // Use split view if enabled
    if (this.config.splitByPerson) {
      return this.getDomSplitByPerson();
    }

    const wrapper = document.createElement("div");

    // Voice Assistant UI
    if (this.config.voiceAssistant && this.config.voiceAssistant.enabled) {
      const voiceControls = document.createElement("div");
      voiceControls.className = "voice-controls";
      
      const micButton = document.createElement("button");
      micButton.className = `voice-mic-button ${this.isListening ? "listening" : ""}`;
      micButton.innerHTML = this.isListening ? "🎙️ Listening..." : "🎤 Voice";
      micButton.addEventListener("click", () => {
        if (this.isListening) {
          this.stopListening();
        } else {
          this.startListening();
        }
      });
      voiceControls.appendChild(micButton);

      if (this.config.voiceAssistant.showTranscription && this.lastTranscript) {
        const transcript = document.createElement("div");
        transcript.className = "voice-transcript xsmall dimmed";
        transcript.textContent = `"${this.lastTranscript}"`;
        voiceControls.appendChild(transcript);
      }

      wrapper.appendChild(voiceControls);
    }

    // Remove the large header showing the global level. Levels are displayed
    // next to each person's name instead.

    if (this.titleChangeMessage) {
      const note = document.createElement("div");
      note.className = "small bright";
      note.innerHTML = this.titleChangeMessage;
      wrapper.appendChild(note);
    }

    const showRedeemed = this.config.usePointSystem && this.config.showRedeemedRewards !== false;
    const pendingRedemptions = showRedeemed
      ? (this.redemptions || []).filter(r => !r.used).sort((a, b) => new Date(b.redeemed) - new Date(a.redeemed))
      : [];

    // Filter out all deleted tasks completely from the mirror
    const visible = this.tasks
      .filter(t => !t.deleted && this.shouldShowTask(t))
      .sort((a, b) => {
        if (a.done && !b.done) return 1;
        if (!a.done && b.done) return -1;
        const da = new Date(a.date);
        const db = new Date(b.date);
        if (da < db) return -1;
        if (da > db) return 1;
        return (a.order || 0) - (b.order || 0);
      });

    // Show pending redemptions above tasks when enabled (no header, no date)
    if (pendingRedemptions.length) {
      const redemptionsWrap = document.createElement("div");
      redemptionsWrap.className = "redemptions-block";

      const list = document.createElement("ul");
      list.className = "normal";

      const redeemedLabel = this.getRedeemedLabel();

      pendingRedemptions.forEach(red => {
        const li = document.createElement("li");
        li.className = `${this.config.textMirrorSize}`;

        const nameEl = document.createElement("strong");
        nameEl.textContent = red.personName || "";

        const labelEl = document.createElement("span");
        labelEl.className = "dimmed";
        labelEl.textContent = redeemedLabel;

        const rewardEl = document.createElement("strong");
        rewardEl.textContent = red.rewardName || "";

        // explicit text nodes to enforce spacing between parts
        const space = document.createTextNode("\u00a0");
        li.append(
          nameEl,
          space.cloneNode(),
          labelEl,
          space.cloneNode(),
          rewardEl
        );
        list.appendChild(li);
      });

      redemptionsWrap.appendChild(list);
      wrapper.appendChild(redemptionsWrap);
    }

    if (pendingRedemptions.length && visible.length) {
      const divider = document.createElement("hr");
      divider.className = "redemptions-divider";
      divider.style.margin = "8px 0";
      wrapper.appendChild(divider);
    }

    if (visible.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = `${this.config.textMirrorSize} dimmed`;
      emptyEl.innerHTML = pendingRedemptions.length ? "" : "No tasks to show 🎉";
      if (!pendingRedemptions.length) {
        wrapper.appendChild(emptyEl);
      }
      return wrapper;
    }

    const ul = document.createElement("ul");
    ul.className = "normal";

    visible.forEach(task => {
      const li = document.createElement("li");
      li.className = `${this.config.textMirrorSize}${task.done ? " task-done" : ""}`;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = task.done;
      cb.style.marginRight = "8px";
      cb.addEventListener("change", () => {
        if (cb.checked && !task.done) {
          this.showCelebration(li);
        }
        li.classList.add("moving");
        setTimeout(() => this.toggleDone(task, cb.checked), 200);
      });
      li.appendChild(cb);

      const dateText = this.formatDate(task.date);
      const text = document.createTextNode(`${task.name} ${dateText}`);
      li.appendChild(text);

      if (task.assignedTo) {
        const p = this.getPerson(task.assignedTo);
        const assignedEl = document.createElement("span");
        assignedEl.className = "xsmall dimmed";
        assignedEl.style.marginLeft = "6px";
        let html = ` — ${p ? p.name : ""}`;
        
        // Show coins if the coin system is active and the mirror toggle allows it; otherwise show level info
        if (this.config.usePointSystem) {
          if (this.config.showCoinsOnMirror !== false && p) {
            const coins = p.points || 0;
            html += ` <span class="coin-badge">🪙${coins}</span>`;
          }
        } else {
          const lvlEnabled = !(
            this.config.leveling && this.config.leveling.enabled === false
          );
          const showLevel = this.config.showLevelOnMirror !== false;
          if (lvlEnabled && showLevel && p && p.level) {
            html += ` <span class="lvl-badge">lvl${p.level}</span>`;
          }
        }
        
        assignedEl.innerHTML = html;
        li.appendChild(assignedEl);
      }

      ul.appendChild(li);
    });

    wrapper.appendChild(ul);

    if (this.config.showAnalyticsOnMirror && this.config.analyticsCards.length) {
      const charts = document.createElement("div");
      charts.className = "analytics-wrapper";
      this.config.analyticsCards.forEach((type, idx) => {
        const card = document.createElement("div");
        card.className = "analytics-card";
        const title = document.createElement("div");
        title.className = "small bright";
        title.innerHTML = BOARD_TITLES[type] || type;
        const canvas = document.createElement("canvas");
        const id = `chart-${idx}`;
        canvas.id = id;
        canvas.className = "analytics-chart";
        card.appendChild(title);
        card.appendChild(canvas);
        charts.appendChild(card);
      });
      wrapper.appendChild(charts);
      setTimeout(() => this.renderCharts(), 0);
    }

    return wrapper;
  }
});
