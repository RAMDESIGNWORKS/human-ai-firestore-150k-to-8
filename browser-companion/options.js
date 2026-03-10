const endpointUrl = document.getElementById('endpointUrl');
const companionToken = document.getElementById('companionToken');
const ownerId = document.getElementById('ownerId');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('saveBtn');

async function load() {
  const values = await chrome.storage.sync.get({
    endpointUrl: '',
    companionToken: '',
    ownerId: '',
  });
  endpointUrl.value = values.endpointUrl;
  companionToken.value = values.companionToken;
  ownerId.value = values.ownerId;
}

async function save() {
  await chrome.storage.sync.set({
    endpointUrl: endpointUrl.value.trim(),
    companionToken: companionToken.value.trim(),
    ownerId: ownerId.value.trim(),
  });
  statusEl.textContent = 'Saved.';
  statusEl.className = 'hint ok';
}

saveBtn.addEventListener('click', save);
load();
