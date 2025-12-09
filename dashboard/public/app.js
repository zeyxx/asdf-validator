/**
 * ASDF Validator Dashboard - Frontend
 */

(function() {
  'use strict';

  // State
  let totalFees = 0;
  let feeCount = 0;
  let orphanFees = 0;
  let orphanFeeCount = 0;
  let chartData = [];
  let isPaused = false;
  let allTokens = [];
  let feeTimestamps = [];

  const MAX_CHART_POINTS = 60;
  const FEE_RATE_WINDOW = 5 * 60 * 1000;
  const ALERT_THRESHOLD = 0.1;

  // DOM elements (will be set after DOM is ready)
  let wsStatus, wsText, creatorAddress, totalFeesEl, bcBalanceEl, ammBalanceEl;
  let feeCountEl, orphanFeesEl, orphanCountEl, feesTbody, tokensTbody, lastUpdateEl;
  let feeRateEl, themeToggle, pauseToggle, tokenFilter, alertsContainer;
  let chart, hourlyChart;

  // Initialize DOM elements
  function initDOMElements() {
    wsStatus = document.getElementById('ws-status');
    wsText = document.getElementById('ws-text');
    creatorAddress = document.getElementById('creator-address');
    totalFeesEl = document.getElementById('total-fees');
    bcBalanceEl = document.getElementById('bc-balance');
    ammBalanceEl = document.getElementById('amm-balance');
    feeCountEl = document.getElementById('fee-count');
    orphanFeesEl = document.getElementById('orphan-fees');
    orphanCountEl = document.getElementById('orphan-count');
    feesTbody = document.getElementById('fees-tbody');
    tokensTbody = document.getElementById('tokens-tbody');
    lastUpdateEl = document.getElementById('last-update');
    feeRateEl = document.getElementById('fee-rate');
    themeToggle = document.getElementById('theme-toggle');
    pauseToggle = document.getElementById('pause-toggle');
    tokenFilter = document.getElementById('token-filter');
    alertsContainer = document.getElementById('alerts-container');
  }

  // Initialize charts
  function initCharts() {
    const ctx = document.getElementById('fees-chart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Cumulative Fees (SOL)',
          data: [],
          borderColor: '#ff6b35',
          backgroundColor: 'rgba(255, 107, 53, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 0,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            display: true,
            grid: { color: 'rgba(255, 255, 255, 0.1)' },
            ticks: { color: '#888', maxTicksLimit: 10 }
          },
          y: {
            display: true,
            grid: { color: 'rgba(255, 255, 255, 0.1)' },
            ticks: { color: '#888' }
          }
        },
        plugins: { legend: { display: false } },
        animation: { duration: 0 }
      }
    });

    const hourlyCtx = document.getElementById('hourly-chart').getContext('2d');
    hourlyChart = new Chart(hourlyCtx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Fees per Hour (SOL)',
          data: [],
          backgroundColor: 'rgba(147, 112, 219, 0.6)',
          borderColor: 'rgba(147, 112, 219, 1)',
          borderWidth: 1,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            display: true,
            grid: { color: 'rgba(255, 255, 255, 0.1)' },
            ticks: { color: '#888', maxRotation: 45, minRotation: 45 }
          },
          y: {
            display: true,
            beginAtZero: true,
            grid: { color: 'rgba(255, 255, 255, 0.1)' },
            ticks: { color: '#888' }
          }
        },
        plugins: { legend: { display: false } },
        animation: { duration: 0 }
      }
    });
  }

  // Format time
  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString();
  }

  function formatShortTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }

  // Update charts
  function updateChart(fees) {
    const now = Date.now();
    chartData.push({ time: now, fees: parseFloat(fees) });
    if (chartData.length > MAX_CHART_POINTS) chartData.shift();
    chart.data.labels = chartData.map(d => formatShortTime(d.time));
    chart.data.datasets[0].data = chartData.map(d => d.fees);
    chart.update('none');
  }

  function updateHourlyChart(feesPerHour) {
    if (!feesPerHour || feesPerHour.length === 0) return;
    hourlyChart.data.labels = feesPerHour.map(b => b.hour);
    hourlyChart.data.datasets[0].data = feesPerHour.map(b => b.amount);
    hourlyChart.update('none');
  }

  function updateChartsTheme(isLight) {
    const gridColor = isLight ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.1)';
    const tickColor = isLight ? '#666' : '#888';

    [chart, hourlyChart].forEach(c => {
      c.options.scales.x.grid.color = gridColor;
      c.options.scales.y.grid.color = gridColor;
      c.options.scales.x.ticks.color = tickColor;
      c.options.scales.y.ticks.color = tickColor;
      c.update('none');
    });
  }

  // Update tokens table
  function updateTokensTable(tokens) {
    if (!tokens || tokens.length === 0) return;
    allTokens = tokens;
    const filterValue = tokenFilter ? tokenFilter.value : '';
    if (filterValue) {
      filterTokens(filterValue);
    } else {
      renderTokensTable(tokens);
    }
  }

  function filterTokens(searchTerm) {
    const term = searchTerm.toLowerCase();
    const filtered = allTokens.filter(token =>
      token.symbol.toLowerCase().includes(term) ||
      token.mint.toLowerCase().includes(term) ||
      (token.name && token.name.toLowerCase().includes(term))
    );
    renderTokensTable(filtered);
  }

  function renderTokensTable(tokens) {
    if (!tokens || tokens.length === 0) {
      tokensTbody.innerHTML = '<tr class="empty-row"><td colspan="6">No tokens found</td></tr>';
      return;
    }
    tokensTbody.innerHTML = '';
    tokens.forEach(token => {
      const row = document.createElement('tr');
      row.className = 'token-row';
      const shortMint = token.mint.substring(0, 4) + '...' + token.mint.substring(token.mint.length - 4);
      const status = token.migrated ? 'AMM' : 'BC';
      const statusClass = token.migrated ? 'migrated' : 'active';
      const displayName = token.name || token.symbol || '-';
      row.innerHTML = `
        <td class="token-symbol">${token.symbol}</td>
        <td class="token-name">${displayName}</td>
        <td class="token-mint" title="${token.mint}">${shortMint}</td>
        <td class="token-fees">${token.totalFees} SOL</td>
        <td class="token-count">${token.feeCount}</td>
        <td class="token-status ${statusClass}">${status}</td>
      `;
      tokensTbody.appendChild(row);
    });
  }

  // Add fee to table
  function addFeeToTable(fee) {
    const emptyRow = feesTbody.querySelector('.empty-row');
    if (emptyRow) emptyRow.remove();

    const row = document.createElement('tr');
    row.className = 'fee-row new';
    row.innerHTML = `
      <td>${formatTime(fee.timestamp)}</td>
      <td class="amount">+${fee.amount} SOL</td>
      <td class="vault ${fee.vault.toLowerCase()}">${fee.vault}</td>
      <td class="slot">${fee.slot}</td>
    `;
    feesTbody.insertBefore(row, feesTbody.firstChild);
    setTimeout(() => row.classList.remove('new'), 500);
    while (feesTbody.children.length > 20) {
      feesTbody.removeChild(feesTbody.lastChild);
    }
  }

  // Connection status
  function setConnected(connected) {
    if (connected) {
      wsStatus.className = 'status-indicator connected';
      wsText.textContent = 'Connected';
    } else {
      wsStatus.className = 'status-indicator disconnected';
      wsText.textContent = 'Disconnected';
    }
  }

  function updateLastUpdate() {
    lastUpdateEl.textContent = formatTime(Date.now());
  }

  // Fee rate
  function updateFeeRate(amount, timestamp) {
    feeTimestamps.push({ amount: parseFloat(amount), timestamp });
    const cutoff = Date.now() - FEE_RATE_WINDOW;
    feeTimestamps = feeTimestamps.filter(f => f.timestamp > cutoff);
    const totalInWindow = feeTimestamps.reduce((sum, f) => sum + f.amount, 0);
    const rate = totalInWindow / (FEE_RATE_WINDOW / 60000);
    feeRateEl.textContent = rate.toFixed(6);
  }

  // Alerts
  function showAlert(message, type, duration) {
    type = type || 'info';
    duration = duration || 5000;
    const alert = document.createElement('div');
    alert.className = 'alert ' + type;
    alert.innerHTML = '<span>' + message + '</span><button class="alert-close">&times;</button>';
    alert.querySelector('.alert-close').addEventListener('click', function() {
      alert.remove();
    });
    alertsContainer.appendChild(alert);
    if (duration > 0) {
      setTimeout(function() { alert.remove(); }, duration);
    }
  }

  function checkFeeThreshold(amount) {
    if (parseFloat(amount) >= ALERT_THRESHOLD) {
      showAlert('Large fee detected: ' + amount + ' SOL', 'warning', 10000);
    }
  }

  // Theme toggle
  function toggleTheme() {
    const isLight = document.body.classList.toggle('light-theme');
    localStorage.setItem('dashboard-theme', isLight ? 'light' : 'dark');
    const icon = themeToggle.querySelector('.theme-icon');
    if (icon) icon.innerHTML = isLight ? '&#9728;' : '&#9790;';
    updateChartsTheme(isLight);
  }

  function initTheme() {
    const savedTheme = localStorage.getItem('dashboard-theme');
    if (savedTheme === 'light') {
      document.body.classList.add('light-theme');
      const icon = themeToggle.querySelector('.theme-icon');
      if (icon) icon.innerHTML = '&#9728;';
    }
  }

  // Pause toggle
  function togglePause() {
    isPaused = !isPaused;
    document.body.classList.toggle('paused', isPaused);
    pauseToggle.classList.toggle('active', isPaused);
    const icon = pauseToggle.querySelector('.pause-icon');
    if (icon) icon.innerHTML = isPaused ? '&#9654;' : '&#9208;';
    pauseToggle.title = isPaused ? 'Resume updates' : 'Pause updates';
    if (isPaused) {
      showAlert('Updates paused', 'info', 3000);
    }
  }

  // WebSocket message handler
  function handleMessage(event) {
    const message = JSON.parse(event.data);

    if (isPaused && message.type !== 'state' && message.type !== 'status') {
      return;
    }

    switch (message.type) {
      case 'state':
        var state = message.data;
        creatorAddress.textContent = state.creator;
        totalFeesEl.textContent = state.totalFees;
        bcBalanceEl.textContent = state.bcBalance;
        ammBalanceEl.textContent = state.ammBalance;
        feeCountEl.textContent = state.feeCount;
        totalFees = parseFloat(state.totalFees);
        feeCount = state.feeCount;
        setConnected(state.connected);

        if (state.orphanFees !== undefined) {
          orphanFeesEl.textContent = state.orphanFees;
          orphanCountEl.textContent = state.orphanFeeCount;
        }

        if (state.recentFees && state.recentFees.length > 0) {
          feesTbody.innerHTML = '';
          state.recentFees.slice(0, 20).reverse().forEach(function(fee) {
            addFeeToTable(fee);
          });
        }

        if (state.tokens) updateTokensTable(state.tokens);
        updateChart(state.totalFees);
        if (state.feesPerHour) updateHourlyChart(state.feesPerHour);
        break;

      case 'fee':
        var fee = message.data;
        totalFeesEl.textContent = fee.totalFees;
        feeCountEl.textContent = fee.feeCount;
        totalFees = parseFloat(fee.totalFees);
        feeCount = fee.feeCount;

        if (fee.orphanFees !== undefined) {
          orphanFeesEl.textContent = fee.orphanFees;
          orphanCountEl.textContent = fee.orphanFeeCount;
        }

        updateFeeRate(fee.amount, fee.timestamp);
        checkFeeThreshold(fee.amount);
        addFeeToTable(fee);
        updateChart(fee.totalFees);
        updateLastUpdate();

        if (fee.tokens) updateTokensTable(fee.tokens);
        if (fee.feesPerHour) updateHourlyChart(fee.feesPerHour);

        var totalCard = document.querySelector('.stat-card.total-fees');
        totalCard.classList.add('flash');
        setTimeout(function() { totalCard.classList.remove('flash'); }, 300);

        if (fee.isOrphan) {
          var orphanCard = document.querySelector('.stat-card.orphan-fees');
          orphanCard.classList.add('flash');
          setTimeout(function() { orphanCard.classList.remove('flash'); }, 300);
        }
        break;

      case 'balance':
        var balance = message.data;
        bcBalanceEl.textContent = balance.bcBalance;
        ammBalanceEl.textContent = balance.ammBalance;
        updateLastUpdate();
        break;

      case 'status':
        setConnected(message.data.connected);
        break;
    }
  }

  // WebSocket connection
  function connect() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(protocol + '//' + window.location.host);

    ws.onopen = function() {
      console.log('WebSocket connected');
      setConnected(true);
    };

    ws.onmessage = handleMessage;

    ws.onclose = function() {
      console.log('WebSocket disconnected');
      setConnected(false);
      setTimeout(connect, 3000);
    };

    ws.onerror = function(error) {
      console.error('WebSocket error:', error);
    };
  }

  // Setup event listeners
  function setupEventListeners() {
    // Theme toggle button
    themeToggle.addEventListener('click', toggleTheme);

    // Pause toggle button
    pauseToggle.addEventListener('click', togglePause);

    // Token filter input
    if (tokenFilter) {
      tokenFilter.addEventListener('input', function(e) {
        filterTokens(e.target.value);
      });
    }
  }

  // Initialize everything when DOM is ready
  function init() {
    initDOMElements();
    initCharts();
    setupEventListeners();
    initTheme();
    connect();

    // Update fee rate every 10 seconds
    setInterval(function() {
      var cutoff = Date.now() - FEE_RATE_WINDOW;
      feeTimestamps = feeTimestamps.filter(function(f) { return f.timestamp > cutoff; });
      var totalInWindow = feeTimestamps.reduce(function(sum, f) { return sum + f.amount; }, 0);
      var rate = totalInWindow / (FEE_RATE_WINDOW / 60000);
      feeRateEl.textContent = rate.toFixed(6);
    }, 10000);
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
