class WorkStatusManager {
  private isWorking: boolean = false;

  setWorking(status: boolean) {
    this.isWorking = status;
  }

  isWorkingStatus(): boolean {
    return this.isWorking;
  }
}

const workStatusManager = new WorkStatusManager();
export default workStatusManager;
