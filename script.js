const API_URL = 'https://finan-as2-0.onrender.com/api';
let token = localStorage.getItem('financia_token');
let modoPrivado = false;

let chartPortfolio = null;
let chartAsset = null;
let chartPerformance = null;
let chartBalanco = null;
let valoresReaisOcultos = {};
let totalAportesAcumulado = 0;
let periodoAtivoPatrimonio = 'meses';

window.addEventListener('DOMContentLoaded', () => {
    if (!token && !window.location.pathname.includes('login.html')) {
        window.location.href = 'login.html';
        return;
    }

    const nomeUser = localStorage.getItem('financia_user') || 'Usuário';
    const avatar = document.getElementById('avatarLetra');
    if (avatar) avatar.innerText = nomeUser.charAt(0).toUpperCase();

    const inputDataAtivo = document.getElementById('inputDataAtivo');
    if (inputDataAtivo) {
        inputDataAtivo.value = new Date().toISOString().split('T')[0];
    }

    inicializarGraficos();
    iniciarTickerCarrosselAoVivo();
    carregarDadosDoBD();
    carregarAtivosPortfolio();
    carregarGastosFixosBD();
    carregarEntradasBD();
    carregarAportesBD();
});

function fazerLogout(e) {
    if (e) e.preventDefault();
    localStorage.removeItem('financia_token');
    localStorage.removeItem('financia_user');
    window.location.href = 'login.html';
}

function alternarFormulario(idForm) {
    const form = document.getElementById(idForm);
    if (form) {
        form.style.display = form.style.display === 'none' || form.style.display === '' ? 'flex' : 'none';
    }
}

function alternarModoPrivacidade() {
    modoPrivado = !modoPrivado;
    const alvos = document.querySelectorAll('.privacy-target');
    const btnPrivado = document.querySelector('.btn-privacy');

    if (btnPrivado) btnPrivado.innerText = modoPrivado ? '👁️ Exibir' : '👁️ Privado';

    alvos.forEach((el, index) => {
        const idChave = el.id || `alvo_${index}`;
        if (modoPrivado) {
            valoresReaisOcultos[idChave] = el.innerText;
            el.innerText = 'R$ ••••••';
        } else {
            if (valoresReaisOcultos[idChave]) el.innerText = valoresReaisOcultos[idChave];
        }
    });
}

function filtrarTempoPatrimonio(periodo, btnElement) {
    periodoAtivoPatrimonio = periodo;
    if (btnElement) {
        document.querySelectorAll('.btn-time').forEach(btn => btn.classList.remove('active'));
        btnElement.classList.add('active');
    }
    const totalAtualText = document.getElementById('totalPortfolioDisplay')?.innerText || 'R$ 0,00';
    const totalNum = parseFloat(totalAtualText.replace('R$', '').replace(/\./g, '').replace(',', '.')) || 0;
    atualizarPatrimonioTotalAuto(totalNum);
}

function atualizarPatrimonioTotalAuto(totalCalculado) {
    const totalDisplay = document.getElementById('totalPortfolioDisplay');
    if (totalDisplay) {
        totalDisplay.innerText = `R$ ${totalCalculado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
    }

    if (!chartPortfolio) return;

    let rotulos = [];
    let pontos = [];
    const hoje = new Date();

    if (periodoAtivoPatrimonio === 'horas') {
        rotulos = ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', 'Agora'];
        const base = totalCalculado * 0.98;
        const degrau = (totalCalculado - base) / 6;
        pontos = [base, base + degrau, base + degrau * 2, base + degrau * 3, base + degrau * 4.5, base + degrau * 5.5, totalCalculado];
    } else if (periodoAtivoPatrimonio === 'dias') {
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(hoje.getDate() - i);
            rotulos.push(`${d.getDate()}/${d.getMonth() + 1}`);
        }
        const fator = totalCalculado / 7;
        pontos = rotulos.map((_, idx) => Math.round(fator * (idx + 1)));
        if (pontos.length > 0) pontos[pontos.length - 1] = totalCalculado;
    } else if (periodoAtivoPatrimonio === 'meses') {
        const diaAtual = hoje.getDate();
        const mesAtual = hoje.getMonth() + 1;
        
        for (let d = 1; d <= diaAtual; d++) {
            rotulos.push(`${d}/${mesAtual}`);
        }

        const numDias = rotulos.length;
        pontos = rotulos.map((_, idx) => {
            const progresso = (idx + 1) / numDias;
            return Math.round(totalCalculado * Math.pow(progresso, 0.75));
        });
        if (pontos.length > 0) pontos[pontos.length - 1] = totalCalculado;
    } else if (periodoAtivoPatrimonio === 'anos') {
        const anoAtual = hoje.getFullYear();
        rotulos = [anoAtual - 2, anoAtual - 1, anoAtual, anoAtual + 1, anoAtual + 2, anoAtual + 5];
        pontos = [
            Math.round(totalCalculado * 0.3),
            Math.round(totalCalculado * 0.6),
            totalCalculado,
            Math.round(totalCalculado * 1.3),
            Math.round(totalCalculado * 1.8),
            Math.round(totalCalculado * 3.2)
        ];
    }

    chartPortfolio.data.labels = rotulos;
    chartPortfolio.data.datasets[0].data = pontos;
    chartPortfolio.update();
}

async function carregarAtivosPortfolio() {
    try {
        const res = await fetch(`${API_URL}/ativos`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const listaAtivos = await res.json();

        let totalCripto = 0;
        let totalAcoes = 0;
        let totalFiis = 0;

        const container = document.getElementById('listaAtivosCadastrados');
        if (container) container.innerHTML = '';

        for (let item of listaAtivos) {
            let valorCalculado = Number(item.quantidade) * Number(item.preco_medio || 0);

            if (item.tipo === 'Cripto') {
                totalCripto += valorCalculado;
            } else if (item.tipo === 'FIIs') {
                totalFiis += valorCalculado;
            } else {
                totalAcoes += valorCalculado;
            }

            if (container) {
                const dataFormatada = item.data_compra ? item.data_compra : 'Data não inf.';
                const div = document.createElement('div');
                div.className = 'transaction-item';
                div.innerHTML = `
                    <div>
                        <strong>${item.ticker} (${item.tipo})</strong>
                        <small>Qtd: ${item.quantidade} • Preço: R$ ${Number(item.preco_medio || 0).toFixed(2)} • Data: ${dataFormatada} • Total: R$ ${valorCalculado.toFixed(2)}</small>
                    </div>
                    <button onclick="removerAtivo(${item.id})" style="background:none; border:none; color:#ff6b6b; cursor:pointer;" title="Excluir ativo">🗑️</button>
                `;
                container.appendChild(div);
            }
        }

        if (chartAsset) {
            chartAsset.data.datasets[0].data = [totalAportesAcumulado, totalCripto, totalAcoes, totalFiis];
            chartAsset.update();
        }

        const patrimonioGeral = totalAportesAcumulado + totalCripto + totalAcoes + totalFiis;
        atualizarPatrimonioTotalAuto(patrimonioGeral);

    } catch (err) {
        console.log("Erro ao carregar ativos.");
    }
}

async function adicionarAtivoPortfolio() {
    const tipoSelect = document.getElementById('inputTipoAtivo');
    const tickerInput = document.getElementById('inputTickerAtivo');
    const qtdInput = document.getElementById('inputQtdAtivo');
    const precoInput = document.getElementById('inputPrecoUnitarioAtivo');
    const dataInput = document.getElementById('inputDataAtivo');

    const tipo = tipoSelect ? tipoSelect.value : 'FIIs';
    const ticker = tickerInput ? tickerInput.value.trim() : '';
    const quantidade = parseFloat(qtdInput ? qtdInput.value.replace(',', '.') : 0);
    const preco_medio = parseFloat(precoInput ? precoInput.value.replace(',', '.') : 0);
    
    let data_compra = dataInput && dataInput.value ? dataInput.value : '';
    if (data_compra && data_compra.includes('-')) {
        const p = data_compra.split('-');
        data_compra = `${p[2]}/${p[1]}/${p[0]}`;
    }

    if (!ticker || isNaN(quantidade) || quantidade <= 0 || isNaN(preco_medio) || preco_medio < 0) {
        alert("Preencha o ticker, a quantidade e o preço pago por cota/unidade.");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/ativos`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ tipo, ticker, quantidade, preco_medio, data_compra })
        });

        if (res.ok) {
            tickerInput.value = '';
            qtdInput.value = '';
            precoInput.value = '';
            alternarFormulario('formAlocacao');
            carregarAtivosPortfolio();
        } else {
            const errData = await res.json();
            alert(errData.erro || "Erro ao salvar ativo.");
        }
    } catch (err) {
        alert("Erro ao conectar com o servidor.");
    }
}

async function removerAtivo(id) {
    try {
        await fetch(`${API_URL}/ativos/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        carregarAtivosPortfolio();
    } catch (e) { }
}

async function iniciarTickerCarrosselAoVivo() {
    const track = document.getElementById('tickerTrack');
    if (!track) return;

    let precosAtivos = [
        { nome: 'Bitcoin (BTC)', preco: 'R$ 380.000,00', var: '+1,20%', classeVar: 'neon-green' },
        { nome: 'Ethereum (ETH)', preco: 'R$ 14.500,00', var: '+0,85%', classeVar: 'neon-green' },
        { nome: 'Solana (SOL)', preco: 'R$ 820,00', var: '+2,10%', classeVar: 'neon-green' },
        { nome: 'MXRF11 (FII)', preco: 'R$ 10,25', var: '+0,45%', classeVar: 'neon-green' },
        { nome: 'GARE11 (FII)', preco: 'R$ 9,10', var: '+0,11%', classeVar: 'neon-green' },
        { nome: 'PETR4 (Ação)', preco: 'R$ 38,40', var: '-1,15%', classeVar: 'neon-pink' },
        { nome: 'BBAS3 (Ação)', preco: 'R$ 27,90', var: '+0,82%', classeVar: 'neon-green' },
        { nome: 'TAEE11 (Unit)', preco: 'R$ 35,20', var: '+0,30%', classeVar: 'neon-green' },
        { nome: 'XPML11 (FII)', preco: 'R$ 104,80', var: '+0,65%', classeVar: 'neon-green' }
    ];

    function renderizarTicker() {
        track.innerHTML = '';
        const ativosDuplicados = [...precosAtivos, ...precosAtivos];

        ativosDuplicados.forEach(item => {
            const div = document.createElement('div');
            div.className = 'ticker-item';
            div.innerHTML = `
                <span class="ticker-nome">${item.nome}</span>
                <span class="ticker-valor privacy-target">${item.preco}</span>
                <span class="${item.classeVar}">${item.var}</span>
            `;
            track.appendChild(div);
        });
    }

    renderizarTicker();

    async function atualizarPrecosReais() {
        try {
            const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=brl&include_24hr_change=true');
            if (!res.ok) return;
            const data = await res.json();
            
            if (data && data.bitcoin && data.bitcoin.brl) {
                const btcVal = data.bitcoin.brl;
                const btcVarVal = data.bitcoin.brl_24h_change || 0;
                precosAtivos[0].preco = `R$ ${btcVal.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                precosAtivos[0].var = `${btcVarVal >= 0 ? '+' : ''}${btcVarVal.toFixed(2)}%`;
                precosAtivos[0].classeVar = btcVarVal >= 0 ? 'neon-green' : 'neon-pink';
            }

            if (data && data.ethereum && data.ethereum.brl) {
                const ethVal = data.ethereum.brl;
                const ethVarVal = data.ethereum.brl_24h_change || 0;
                precosAtivos[1].preco = `R$ ${ethVal.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                precosAtivos[1].var = `${ethVarVal >= 0 ? '+' : ''}${ethVarVal.toFixed(2)}%`;
                precosAtivos[1].classeVar = ethVarVal >= 0 ? 'neon-green' : 'neon-pink';
            }

            if (data && data.solana && data.solana.brl) {
                const solVal = data.solana.brl;
                const solVarVal = data.solana.brl_24h_change || 0;
                precosAtivos[2].preco = `R$ ${solVal.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                precosAtivos[2].var = `${solVarVal >= 0 ? '+' : ''}${solVarVal.toFixed(2)}%`;
                precosAtivos[2].classeVar = solVarVal >= 0 ? 'neon-green' : 'neon-pink';
            }

            renderizarTicker();
        } catch (e) {
            console.log("Mantendo valores padrão no carrossel.");
        }
    }

    atualizarPrecosReais();
    setInterval(atualizarPrecosReais, 30000);
}

async function carregarEntradasBD() {
    try {
        const res = await fetch(`${API_URL}/entradas`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const lista = await res.json();
        const container = document.getElementById('listaEntradasCadastradas');
        if (!container) return;

        container.innerHTML = '';
        let totalEntradas = 0;

        lista.forEach(item => {
            const v = parseFloat(item.valor) || 0;
            totalEntradas += v;

            const div = document.createElement('div');
            div.className = 'transaction-item';
            div.innerHTML = `
                <div>
                    <strong>${item.descricao}</strong>
                    <small>${item.data}</small>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span class="privacy-target" style="color: var(--verde-destaque); font-weight:700;">+ R$ ${v.toFixed(2).replace('.', ',')}</span>
                    <button onclick="removerEntrada(${item.id})" style="background:none; border:none; color:#ff6b6b; cursor:pointer;" title="Excluir entrada">🗑️</button>
                </div>
            `;
            container.appendChild(div);
        });

        const display = document.getElementById('totalEntradasDisplay');
        if (display) display.innerText = `R$ ${totalEntradas.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

        atualizarGraficoBalanco();
    } catch (e) { }
}

async function adicionarEntrada() {
    const descInput = document.getElementById('entradaDesc');
    const valInput = document.getElementById('entradaVal');

    const descricao = descInput ? descInput.value.trim() : '';
    const valor = parseFloat(valInput ? valInput.value.replace(',', '.') : 0);

    if (!descricao || isNaN(valor) || valor <= 0) {
        alert("Preencha a descrição e o valor da entrada.");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/entradas`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ descricao, valor })
        });

        if (res.ok) {
            descInput.value = '';
            valInput.value = '';
            carregarEntradasBD();
        }
    } catch (err) { }
}

async function removerEntrada(id) {
    try {
        const res = await fetch(`${API_URL}/entradas/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) carregarEntradasBD();
    } catch (e) { }
}

async function carregarDadosDoBD() {
    try {
        const res = await fetch(`${API_URL}/extrato`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.status === 401 || res.status === 403) { fazerLogout(); return; }
        const lista = await res.json();
        const listContainer = document.getElementById('transactionList');
        if (!listContainer) return;

        listContainer.innerHTML = '';
        let tMercado = 0, tCasa = 0, tLazer = 0, tTransporte = 0, tCompras = 0;

        lista.forEach(item => {
            const v = parseFloat(item.valor) || 0;
            if (item.categoria === 'Mercado') tMercado += v;
            else if (item.categoria === 'Casa') tCasa += v;
            else if (item.categoria === 'Lazer') tLazer += v;
            else if (item.categoria === 'Transporte') tTransporte += v;
            else if (item.categoria === 'Compras') tCompras += v;

            const div = document.createElement('div');
            div.className = 'transaction-item';
            div.innerHTML = `
                <div>
                    <strong>${item.descricao}</strong>
                    <small>${item.data} • [${item.categoria}]</small>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <span class="trans-amount expense privacy-target">- R$ ${v.toFixed(2).replace('.', ',')}</span>
                    <button onclick="removerTransacaoExtrato(${item.id})" style="background:none; border:none; color:#ff6b6b; cursor:pointer;" title="Excluir do extrato">🗑️</button>
                </div>
            `;
            listContainer.appendChild(div);
        });

        if (document.getElementById('catMercadoDisplay')) document.getElementById('catMercadoDisplay').innerText = `R$ ${tMercado.toFixed(2).replace('.', ',')}`;
        if (document.getElementById('catCasaDisplay')) document.getElementById('catCasaDisplay').innerText = `R$ ${tCasa.toFixed(2).replace('.', ',')}`;
        if (document.getElementById('catLazerDisplay')) document.getElementById('catLazerDisplay').innerText = `R$ ${tLazer.toFixed(2).replace('.', ',')}`;
        if (document.getElementById('catTransporteDisplay')) document.getElementById('catTransporteDisplay').innerText = `R$ ${tTransporte.toFixed(2).replace('.', ',')}`;
        if (document.getElementById('catComprasDisplay')) document.getElementById('catComprasDisplay').innerText = `R$ ${tCompras.toFixed(2).replace('.', ',')}`;
        
        atualizarGraficoBalanco();
    } catch (e) { }
}

async function adicionarGastoSimulado(e) {
    if (e) e.preventDefault();
    const descInput = document.getElementById('simDesc');
    const valInput = document.getElementById('simVal');

    const desc = descInput ? descInput.value.trim() : '';
    const val = valInput ? valInput.value.replace(',', '.') : '';

    if (!desc || !val || isNaN(parseFloat(val))) {
        alert("Preencha descrição e valor válidos.");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/transacao`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ descricao: desc, valor: val })
        });

        if (res.ok) {
            descInput.value = '';
            valInput.value = '';
            carregarDadosDoBD();
        }
    } catch (err) { }
}

async function removerTransacaoExtrato(id) {
    try {
        const res = await fetch(`${API_URL}/transacao/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) carregarDadosDoBD();
    } catch (e) { }
}

async function carregarGastosFixosBD() {
    try {
        const res = await fetch(`${API_URL}/gastos-fixos`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const lista = await res.json();
        const listContainer = document.getElementById('fixedExpensesList');
        if (!listContainer) return;

        listContainer.innerHTML = '';
        let totalFixed = 0;

        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        lista.forEach(item => {
            const v = parseFloat(item.valor) || 0;
            totalFixed += v;

            let statusBadge = '<span class="status-badge" style="color: var(--verde-destaque); border-color: var(--borda-vidro);">🟢 Em Dia</span>';
            
            if (item.vencimento && item.vencimento.includes('/')) {
                const partes = item.vencimento.split('/');
                const dia = parseInt(partes[0]);
                const mes = parseInt(partes[1]) - 1;
                const anoAtual = hoje.getFullYear();

                const dataVenc = new Date(anoAtual, mes, dia);
                dataVenc.setHours(0, 0, 0, 0);

                const diffDias = Math.ceil((dataVenc - hoje) / (1000 * 60 * 60 * 24));

                if (diffDias < 0) {
                    statusBadge = '<span class="status-badge" style="color: #ff6b6b; border-color: rgba(255,107,107,0.3); background: rgba(255,107,107,0.1);">🔴 Vencido</span>';
                } else if (diffDias <= 3) {
                    statusBadge = '<span class="status-badge" style="color: #f1c40f; border-color: rgba(241,196,15,0.3); background: rgba(241,196,15,0.1);">🟡 A Vencer</span>';
                }
            }

            const div = document.createElement('div');
            div.className = 'fixed-item';
            div.innerHTML = `
                <div>
                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                        <strong>${item.descricao}</strong>
                        ${statusBadge}
                    </div>
                    <small>Vencimento: ${item.vencimento || 'Mensal'}</small>
                </div>
                <div class="fixed-item-actions">
                    <span class="fixed-amount privacy-target">R$ ${v.toFixed(2).replace('.', ',')}</span>
                    <button onclick="marcarGastoComoPago(${item.id})" style="background: rgba(0, 255, 136, 0.15); border: 1px solid var(--verde-destaque); color: var(--verde-destaque); padding: 5px 10px; border-radius: 8px; font-weight: 700; cursor: pointer;" title="Dar baixa como pago">✅ Pago</button>
                    <button onclick="removerGastoFixo(${item.id})" style="background:none; border:none; color:#ff6b6b; cursor:pointer;" title="Excluir conta">🗑️</button>
                </div>
            `;
            listContainer.appendChild(div);
        });

        const totalFixedDisplay = document.getElementById('totalFixedDisplay');
        if (totalFixedDisplay) {
            totalFixedDisplay.innerText = `R$ ${totalFixed.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
        }
        
        atualizarGraficoBalanco();
    } catch (e) {
        console.log("Erro ao carregar gastos fixos.");
    }
}

async function marcarGastoComoPago(id) {
    try {
        const res = await fetch(`${API_URL}/gastos-fixos/${id}/pago`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            carregarGastosFixosBD();
            carregarDadosDoBD();
        }
    } catch (e) { }
}

async function adicionarGastoFixo() {
    const descInput = document.getElementById('fixedDesc');
    const valInput = document.getElementById('fixedVal');
    const dateInput = document.getElementById('fixedDate');

    const desc = descInput ? descInput.value.trim() : '';
    const val = valInput ? valInput.value.replace(',', '.') : '';
    const date = dateInput ? dateInput.value : '';

    if (!desc || !val || isNaN(parseFloat(val))) {
        alert("Preencha a descrição e o valor.");
        return;
    }

    let dataFormatada = 'Mensal';
    if (date) {
        const partes = date.split('-');
        if (partes.length === 3) dataFormatada = `${partes[2]}/${partes[1]}`;
    }

    try {
        const res = await fetch(`${API_URL}/gastos-fixos`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ descricao: desc, valor: val, vencimento: dataFormatada })
        });

        if (res.ok) {
            descInput.value = '';
            valInput.value = '';
            if (dateInput) dateInput.value = '';
            carregarGastosFixosBD();
        }
    } catch (err) { }
}

async function removerGastoFixo(id) {
    try {
        const res = await fetch(`${API_URL}/gastos-fixos/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) carregarGastosFixosBD();
    } catch (e) { }
}

function inicializarGraficos() {
    const pCanvas = document.getElementById('portfolioChart');
    if (pCanvas) {
        chartPortfolio = new Chart(pCanvas.getContext('2d'), {
            type: 'line',
            data: { 
                labels: ['Início'], 
                datasets: [{ 
                    label: 'Patrimônio Total (R$)', 
                    data: [0], 
                    borderColor: '#00ff88', 
                    borderWidth: 2.5,
                    backgroundColor: (context) => {
                        const ctx = context.chart.ctx;
                        const gradient = ctx.createLinearGradient(0, 0, 0, 250);
                        gradient.addColorStop(0, 'rgba(0, 255, 136, 0.35)');
                        gradient.addColorStop(1, 'rgba(0, 255, 136, 0.0)');
                        return gradient;
                    },
                    fill: true,
                    tension: 0.35,
                    pointBackgroundColor: '#00ff88',
                    pointBorderColor: '#0b2d21',
                    pointRadius: 4,
                    pointHoverRadius: 7
                }] 
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false, 
                plugins: { 
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let value = context.raw || 0;
                                return ' Patrimônio: R$ ' + value.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
                            }
                        }
                    }
                },
                scales: {
                    y: { 
                        display: true,
                        grid: { color: 'rgba(255,255,255,0.06)' },
                        ticks: {
                            color: '#a0a0a0',
                            font: { size: 10 },
                            callback: function(value) {
                                return 'R$ ' + value.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
                            }
                        }
                    },
                    x: { 
                        display: true,
                        grid: { color: 'rgba(255,255,255,0.03)' },
                        ticks: {
                            color: '#a0a0a0',
                            font: { size: 11 }
                        }
                    }
                }
            }
        });
    }

    const aCanvas = document.getElementById('assetChart');
    if (aCanvas) {
        chartAsset = new Chart(aCanvas.getContext('2d'), {
            type: 'doughnut',
            data: { 
                labels: ['Reserva (Aportes)', 'Cripto', 'Ações', 'FIIs'], 
                datasets: [{ 
                    data: [0, 0, 0, 0], 
                    backgroundColor: ['#00ff88', '#a855f7', '#00d2ff', '#ffb700'], 
                    borderWidth: 0
                }] 
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { color: '#ccc', font: { size: 11 }, usePointStyle: true, boxWidth: 8 }
                    }
                }
            }
        });
    }

    const perfCanvas = document.getElementById('performanceChart');
    if (perfCanvas) {
        chartPerformance = new Chart(perfCanvas.getContext('2d'), {
            type: 'bar',
            data: { 
                labels: ['Início'], 
                datasets: [{ 
                    label: 'Aporte', 
                    data: [0], 
                    backgroundColor: '#00ff88',
                    borderRadius: 6,
                    maxBarThickness: 50,
                    barPercentage: 0.6
                }] 
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false, 
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#888', font: { size: 11 } } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', font: { size: 10 } } }
                }
            }
        });
    }

    const balancoCanvas = document.getElementById('balancoChart');
    if (balancoCanvas) {
        chartBalanco = new Chart(balancoCanvas.getContext('2d'), {
            type: 'bar',
            data: { 
                labels: ['Entradas', 'Saídas'], 
                datasets: [{ 
                    label: 'R$', 
                    data: [0, 0], 
                    backgroundColor: ['#00ff88', '#ff6b6b'],
                    borderRadius: 6,
                    maxBarThickness: 65,
                    barPercentage: 0.55
                }] 
            },
            options: { 
                responsive: true, 
                maintainAspectRatio: false, 
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#888', font: { size: 11 } } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#888', font: { size: 10 } } }
                }
            }
        });
    }
}

async function carregarAportesBD() {
    try {
        const res = await fetch(`${API_URL}/aportes`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const lista = await res.json();
        
        totalAportesAcumulado = 0;
        if (chartPerformance) {
            chartPerformance.data.labels = [];
            chartPerformance.data.datasets[0].data = [];
        }

        const containerAportes = document.getElementById('listaAportesCadastrados');
        if (containerAportes) containerAportes.innerHTML = '';

        lista.forEach(item => {
            const v = parseFloat(item.valor) || 0;
            totalAportesAcumulado += v;

            if (chartPerformance) {
                chartPerformance.data.labels.push(item.mes);
                chartPerformance.data.datasets[0].data.push(v);
            }

            if (containerAportes) {
                const div = document.createElement('div');
                div.className = 'transaction-item';
                div.innerHTML = `
                    <div>
                        <strong>${item.mes}</strong>
                        <small>Aporte de Reserva</small>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span class="privacy-target" style="color: var(--verde-destaque); font-weight:700;">R$ ${v.toFixed(2).replace('.', ',')}</span>
                        <button onclick="removerAporte(${item.id})" style="background:none; border:none; color:#ff6b6b; cursor:pointer;" title="Excluir aporte">🗑️</button>
                    </div>
                `;
                containerAportes.appendChild(div);
            }
        });

        if (chartPerformance) chartPerformance.update();
        salvarMetaReserva();
        carregarAtivosPortfolio();
        atualizarGraficoBalanco();
    } catch (e) { }
}

async function removerAporte(id) {
    try {
        const res = await fetch(`${API_URL}/aportes/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) carregarAportesBD();
    } catch (e) { }
}

async function adicionarAporteMes() {
    const inputMes = document.getElementById('inputAporteMes');
    const inputVal = document.getElementById('inputAporteVal');

    const m = inputMes ? inputMes.value.trim() : '';
    const v = parseFloat(inputVal ? inputVal.value.replace(',', '.') : 0);

    if (!m || isNaN(v) || v <= 0) {
        alert("Preencha o mês e o valor do aporte.");
        return;
    }

    try {
        const res = await fetch(`${API_URL}/aportes`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ mes: m, valor: v })
        });

        if (res.ok) {
            inputMes.value = '';
            inputVal.value = '';
            alternarFormulario('formAporte');
            carregarAportesBD();
        }
    } catch (err) { }
}

function atualizarGraficoBalanco() {
    if (!chartBalanco) return;
    const totalEntradas = Array.from(document.querySelectorAll('#listaEntradasCadastradas .transaction-item span'))
        .reduce((acc, el) => acc + (parseFloat(el.innerText.replace('+ R$', '').replace(/\./g, '').replace(',', '.')) || 0), 0);

    const totalFixos = Array.from(document.querySelectorAll('#fixedExpensesList .fixed-amount'))
        .reduce((acc, el) => acc + (parseFloat(el.innerText.replace('R$', '').replace(/\./g, '').replace(',', '.')) || 0), 0);

    const totalVariaveis = Array.from(document.querySelectorAll('#transactionList .trans-amount'))
        .reduce((acc, el) => acc + (parseFloat(el.innerText.replace('- R$', '').replace(/\./g, '').replace(',', '.')) || 0), 0);

    const totalGastosConsumo = totalFixos + totalVariaveis;
    const totalSaidasGeral = totalGastosConsumo + totalAportesAcumulado;
    const saldoLivreReal = totalEntradas - totalSaidasGeral;

    chartBalanco.data.datasets[0].data = [totalEntradas, totalSaidasGeral];
    chartBalanco.update();

    const pctComprometido = totalEntradas > 0 ? (totalSaidasGeral / totalEntradas) * 100 : 0;
    const barraGasto = document.getElementById('barraGastoProporcao');
    const textoGasto = document.getElementById('textoPorcentagemGastos');
    const badgeStatus = document.getElementById('badgeStatusGasto');
    const alertaGastoTexto = document.getElementById('alertaGastoTexto');

    if (barraGasto && textoGasto && badgeStatus) {
        const larguraVisual = Math.min(Math.round(pctComprometido), 100);
        barraGasto.style.width = `${larguraVisual}%`;
        
        textoGasto.innerHTML = `${pctComprometido.toFixed(1).replace('.', ',')}% comprometido | <span style="color: var(--verde-destaque);">Livre: R$ ${saldoLivreReal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>`;

        if (pctComprometido <= 70) {
            barraGasto.style.backgroundColor = '#00ff88';
            badgeStatus.innerText = '🟢 Saudável';
            badgeStatus.style.color = '#00ff88';
            if (alertaGastoTexto) alertaGastoTexto.innerText = `💡 Excelente! Você ainda tem R$ ${saldoLivreReal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} livres na conta após gastar e investir.`;
        } else if (pctComprometido <= 90) {
            barraGasto.style.backgroundColor = '#f1c40f';
            badgeStatus.innerText = '🟡 Atenção';
            badgeStatus.style.color = '#f1c40f';
            if (alertaGastoTexto) alertaGastoTexto.innerText = `⚠️ Boa gestão de aportes, mas o saldo livre baixou para R$ ${saldoLivreReal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`;
        } else {
            barraGasto.style.backgroundColor = '#ff6b6b';
            badgeStatus.innerText = '🔴 Extremo';
            badgeStatus.style.color = '#ff6b6b';
            if (alertaGastoTexto) alertaGastoTexto.innerText = `🚨 ALERTA: O compromisso total atingiu ${pctComprometido.toFixed(1)}%. Saldo livre atual: R$ ${saldoLivreReal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.`;
        }
    }
}

function salvarPatrimonioInicial() {
    const v = parseFloat(document.getElementById('inputNovoPatrimonio').value) || 0;
    atualizarPatrimonioTotalAuto(v);
    alternarFormulario('formPatrimonio');
}

function salvarMetaReserva() {
    const t = parseFloat(document.getElementById('inputMetaTotal').value) || 10000;
    const metaTextoAtual = document.getElementById('metaTextDisplay');
    const pct = Math.min(Math.round((totalAportesAcumulado / t) * 100), 100);
    if (metaTextoAtual) {
        metaTextoAtual.innerText = `R$ ${totalAportesAcumulado.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} / R$ ${t.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} (${pct}%)`;
    }
    const barra = document.getElementById('metaProgressBar');
    if (barra) barra.style.width = `${pct}%`;
    alternarFormulario('formMeta');
}

async function gerarRelatorioPDF(e) {
    if (e) e.preventDefault();
    
    if (!window.jspdf || !window.jspdf.jsPDF) {
        alert("A biblioteca jsPDF não foi carregada corretamente.");
        return;
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        const nomeUsuario = localStorage.getItem('financia_user') || 'Usuário';
        let y = 20;

        doc.setFillColor(11, 45, 33);
        doc.rect(0, 0, 210, 30, 'F');
        doc.setTextColor(0, 255, 136);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(18);
        doc.text("FINANCIA AUTÔNOMA", 14, 18);
        
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(`Relatório Consolidado • Usuário: ${nomeUsuario} • Data: ${new Date().toLocaleDateString('pt-BR')}`, 14, 25);

        y = 40;

        const totalPatrimonio = document.getElementById('totalPortfolioDisplay')?.innerText || 'R$ 0,00';
        const metaReserva = document.getElementById('metaTextDisplay')?.innerText || 'R$ 0,00';

        doc.setTextColor(5, 28, 20);
        doc.setFontSize(12);
        doc.setFont("helvetica", "bold");
        doc.text("1. RESUMO GERAL", 14, y);
        y += 6;
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(`Patrimônio Total Calculado: ${totalPatrimonio}`, 14, y);
        y += 5;
        doc.text(`Progresso Meta de Reserva: ${metaReserva}`, 14, y);
        y += 10;

        const buscarDados = async (endpoint) => {
            try {
                const res = await fetch(`${API_URL}/${endpoint}`, { headers: { 'Authorization': `Bearer ${token}` } });
                return res.ok ? await res.json() : [];
            } catch { return []; }
        };

        const [entradas, transacoes, fixos, ativos] = await Promise.all([
            buscarDados('entradas'),
            buscarDados('extrato'),
            buscarDados('gastos-fixos'),
            buscarDados('ativos')
        ]);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("2. ENTRADAS & SALÁRIOS", 14, y);
        y += 6;
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");

        if (!entradas || entradas.length === 0) {
            doc.text("Nenhuma entrada cadastrada.", 14, y);
            y += 8;
        } else {
            entradas.forEach(item => {
                doc.text(`• ${item.data || ''} - ${item.descricao || ''}: + R$ ${parseFloat(item.valor || 0).toFixed(2)}`, 14, y);
                y += 5;
            });
            y += 3;
        }

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("3. GASTOS VARIÁVEIS", 14, y);
        y += 6;
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");

        if (!transacoes || transacoes.length === 0) {
            doc.text("Nenhum gasto variável cadastrado.", 14, y);
            y += 8;
        } else {
            transacoes.forEach(item => {
                doc.text(`• ${item.data || ''} - ${item.descricao || ''} [${item.categoria || ''}]: - R$ ${parseFloat(item.valor || 0).toFixed(2)}`, 14, y);
                y += 5;
                if (y > 270) { doc.addPage(); y = 20; }
            });
            y += 3;
        }

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("4. COMPROMISSOS FIXOS MENSAIS", 14, y);
        y += 6;
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");

        if (!fixos || fixos.length === 0) {
            doc.text("Nenhum gasto fixo cadastrado.", 14, y);
            y += 8;
        } else {
            fixos.forEach(item => {
                doc.text(`• ${item.descricao || ''} (Vencimento: ${item.vencimento || ''}): R$ ${parseFloat(item.valor || 0).toFixed(2)}`, 14, y);
                y += 5;
                if (y > 270) { doc.addPage(); y = 20; }
            });
            y += 3;
        }

        doc.setFont("helvetica", "bold");
        doc.setFontSize(12);
        doc.text("5. PORTFÓLIO DE ATIVOS & INVESTIMENTOS", 14, y);
        y += 6;
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");

        if (!ativos || ativos.length === 0) {
            doc.text("Nenhum ativo cadastrado no portfólio.", 14, y);
            y += 8;
        } else {
            ativos.forEach(item => {
                const totalAtivo = Number(item.quantidade || 0) * Number(item.preco_medio || 0);
                doc.text(`• ${item.ticker || ''} (${item.tipo || ''}) - Qtd: ${item.quantidade || 0} | Preço: R$ ${Number(item.preco_medio || 0).toFixed(2)} | Data: ${item.data_compra || 'N/I'} | Total: R$ ${totalAtivo.toFixed(2)}`, 14, y);
                y += 5;
                if (y > 270) { doc.addPage(); y = 20; }
            });
        }

        const paginas = doc.internal.getNumberOfPages();
        for (let i = 1; i <= paginas; i++) {
            doc.setPage(i);
            doc.setFontSize(8);
            doc.setTextColor(150, 150, 150);
            doc.text(`FinancIA Autônoma - Documento gerado automaticamente • Página ${i} de ${paginas}`, 14, 288);
        }

        doc.save(`FinancIA_Extrato_Consolidado_${Date.now()}.pdf`);
    } catch (err) {
        console.error("Erro ao gerar PDF:", err);
        alert("Erro ao compilar informações para o PDF: " + err.message);
    }
}

async function importarArquivoOFX(input) {
    const arquivo = input.files[0];
    if (!arquivo) return;

    const tokenAtual = localStorage.getItem('financia_token');
    if (!tokenAtual) {
        alert("Sessão expirada. Faça login novamente.");
        window.location.href = 'login.html';
        return;
    }

    const formData = new FormData();

    // Se for PDF, extrai o texto no navegador para garantir 100% de compatibilidade com extratos do Mercado Pago/Bancos
    if (arquivo.type === 'application/pdf' || arquivo.name.toLowerCase().endsWith('.pdf')) {
        try {
            const arrayBuffer = await arquivo.arrayBuffer();
            const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            let textoCompleto = '';

            for (let i = 1; i <= pdfDoc.numPages; i++) {
                const pagina = await pdfDoc.getPage(i);
                const conteudoPagina = await pagina.getTextContent();
                const textoPagina = conteudoPagina.items.map(item => item.str).join(' ');
                textoCompleto += textoPagina + '\n';
            }

            if (!textoCompleto.trim()) {
                alert("O PDF parece estar vazio ou escaneado como imagem.");
                return;
            }

            const arquivoTexto = new File([textoCompleto], "extrato_convertido.txt", { type: "text/plain" });
            formData.append('arquivoOfx', arquivoTexto);
        } catch (e) {
            console.error("Erro ao ler PDF no navegador:", e);
            alert("Não foi possível ler este PDF. Tente enviar em formato OFX.");
            return;
        }
    } else {
        formData.append('arquivoOfx', arquivo);
    }

    try {
        const resposta = await fetch(`${API_URL}/importar-ofx`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tokenAtual}`
            },
            body: formData
        });

        const resultado = await resposta.json();
        if (resposta.ok) {
            alert(resultado.mensagem);
            window.location.reload();
        } else {
            alert(resultado.erro || "Erro ao importar arquivo.");
        }
    } catch (err) {
        console.error("Erro na requisição:", err);
        alert("Erro de conexão com o servidor.");
    }
}