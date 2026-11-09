// Feature-removal regression harness, not an emulator of an actual iOS device.
module.exports = () => {
  Object.hasOwn = undefined;
  if (window.HTMLDialogElement) {
    for (const name of ["show", "showModal", "close", "open"])
      delete HTMLDialogElement.prototype[name];
  }
};
